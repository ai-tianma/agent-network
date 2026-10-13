import { afterAll, beforeEach, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../server/src/db";
import { registerTools } from "../../server/src/tools";
import { markTaskActivity } from "../../server/src/task-activity";
import { CodexAppServerClient } from "../../agent-node/src/runtime/codex-app-server-client";
import { CodexAppServerBridge } from "../../agent-node/src/runtime/codex-app-server-bridge";
import { TurnReceiptLedger, recoverTurnReceipts } from "../../agent-node/src/runtime/codex-app-server/receipt-ledger";
import { decideFollowUpHubState } from "../../agent-node/src/runtime/codex-app-server/followup-hub-check";

const NET="net_owned_followup_reply", USER="user_owned_followup_reply", NODE="owned_followup_node", OTHER="owned_followup_other";
const THREAD="owned-followup-thread";
const roots:string[]=[];
function cleanup() {
  for(const table of ["task_late_replies","task_events","tasks","inbox","sessions","api_tokens","nodes","network_members","networks"])
    db.run(`DELETE FROM ${table} WHERE network_id=?1`,[NET]);
  db.run("DELETE FROM users WHERE user_id=?1",[USER]);
  for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
}
beforeEach(()=>{
  cleanup();
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES (?1,?1,'x','user')",[USER]);
  db.run("INSERT INTO networks(network_id,network_name,owner_id) VALUES (?1,?1,?2)",[NET,USER]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES (?1,?2,'owner')",[USER,NET]);
  for(const alias of [NODE,OTHER]) {
    db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,hostname,lifecycle_state) VALUES (?1,?2,?2,?3,'test','active')",[`id_${alias}`,alias,NET]);
    db.run("INSERT INTO api_tokens(token_id,token_hash,user_id,network_id,name,bound_node_id) VALUES (?1,?1,?2,?3,?4,?5)",[`token_${alias}`,USER,NET,`node:${alias}`,`id_${alias}`]);
    db.run("INSERT INTO sessions(resume_id,alias,status,node_id,network_id,updated_at,last_seen_at) VALUES (?1,?2,'idle',?3,?4,datetime('now'),datetime('now'))",[`resume_${alias}`,alias,`id_${alias}`,NET]);
  }
});
afterAll(cleanup);
function handlers(alias?:string) {
  const server=new McpServer({name:"owned-followup-reply",version:"0"}) as any;
  const tools:Record<string,(args:any)=>Promise<any>>={};
  const original=server.tool.bind(server);
  server.tool=(name:string,description:string,schema:any,handler:any)=>{tools[name]=handler;return original(name,description,schema,handler);};
  registerTools(server,undefined,NET,USER,alias??USER,!!alias,alias?`token_${alias}`:null);
  return tools;
}
async function call(tool:any,args:any) {return JSON.parse((await tool(args)).content[0].text);}
async function task(body:string) {
  const reply=await call(handlers().send_task,{alias:NODE,task:body,priority:"normal"});
  expect(reply.ok).toBe(true); return reply.task_id??reply.message_id;
}
function row(taskId:string) {return db.get<any>("SELECT * FROM tasks WHERE task_id=?1",taskId)!;}
function consume(tool:any,taskId:string,turnId:string) {
  return call(tool.mark_tasks_consumed,{task_ids:[taskId],task_contexts:[{task_id:taskId,thread_id:THREAD,turn_id:turnId}]});
}

test("real Hub + WS: independent reply turn keeps original consumption and only answers its task",async()=>{
  const owner=await task("owner action"), follow=await task("already accepted human action");
  const node=handlers(NODE);
  expect((await consume(node,owner,"owner-turn")).ok).toBe(true);
  expect((await consume(node,follow,"owner-turn")).ok).toBe(true);
  const root=mkdtempSync(join(tmpdir(),"hub-followup-"));roots.push(root);
  const ledger=new TurnReceiptLedger(join(root,"receipts.json"));
  ledger.prepareFollowUp({taskId:follow,inboxId:follow,replyTo:USER,threadId:THREAD,ownerTaskId:owner,ownerTurnId:"owner-turn",startedAt:Date.now(),nonce:"a".repeat(32),inputSha256:"b".repeat(64)});
  ledger.acceptFollowUp(follow,{ownerTurnId:"owner-turn",nonce:"a".repeat(32)});
  expect(decideFollowUpHubState(ledger.load()[0] as any,await call(node.get_task,{task_id:follow}),`id_${NODE}`)).toBe("pending");
  const methods:string[]=[], inputs:string[]=[];
  const server=Bun.serve({port:0,fetch(req,srv){if(srv.upgrade(req))return;return new Response("upgrade",{status:400});},websocket:{message(ws,raw){
    const msg=JSON.parse(String(raw));methods.push(msg.method);
    if(msg.method==="turn/start") {
      inputs.push(msg.params.input[0].text);
      ws.send(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{turn:{id:"answer-turn"}}}));
      ws.send(JSON.stringify({jsonrpc:"2.0",method:"item/completed",params:{threadId:THREAD,turnId:"answer-turn",item:{type:"userMessage",clientId:msg.params.clientUserMessageId}}}));
    } else if(msg.method==="thread/turns/list") ws.send(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{data:[{id:"answer-turn",status:"completed",items:[{type:"userMessage",clientId:`anet:${follow}`},{type:"agentMessage",phase:"final_answer",text:"follow-up answer only"}]}],nextCursor:null}}));
  }}});
  const client=new CodexAppServerClient({url:`ws://127.0.0.1:${server.port}`});
  try {
    await client.connect(); const bridge=new CodexAppServerBridge({client,threadId:THREAD});
    const answerTurn=await bridge.startTaskTurn({taskId:follow,text:"Only answer this already accepted task from existing results. Do not execute actions again."});
    ledger.bindFollowUpAnswer(follow,{threadId:THREAD,turnId:answerTurn,clientUserMessageId:`anet:${follow}`});
    const recovered=await recoverTurnReceipts({rows:ledger.load(),inspect:(t,u,c)=>bridge.inspectPersistedTurn(t,u,c)});
    expect(recovered.receipts).toHaveLength(1);
    const receipt=recovered.receipts[0];expect(receipt.entry.taskId).toBe(follow);
    expect((await consume(node,follow,answerTurn)).error).toBe("task_runtime_context_conflict");
    expect(markTaskActivity({tokenId:`token_${NODE}`,networkId:NET,nodeToken:true,identityRejected:false,taskIds:[follow],contexts:[{task_id:follow,thread_id:THREAD,turn_id:answerTurn}]}).error).toBe("task_runtime_context_conflict");
    expect(row(follow).last_activity_at).toBeNull();
    expect((await call(handlers(OTHER).send_reply,{in_reply_to:follow,text:receipt.text})).error).toBe("reply_task_not_owned");
    expect((await call(node.send_reply,{in_reply_to:owner,text:"owner result"})).ok).toBe(true);
    expect(row(follow).status).not.toBe("replied");
    expect((await call(node.send_reply,{in_reply_to:follow,text:receipt.text})).ok).toBe(true);
    expect(row(owner).result).toBe("owner result");expect(row(follow).result).toBe("follow-up answer only");
    expect(row(follow)).toMatchObject({thread_id:THREAD,turn_id:"owner-turn",status:"replied",last_activity_at:null});
    expect(decideFollowUpHubState(ledger.load()[0] as any,await call(node.get_task,{task_id:follow}),`id_${NODE}`)).toBe("terminal");
    expect((await call(node.send_reply,{in_reply_to:follow,text:receipt.text})).error).toBe("reply_task_terminal");
    expect(inputs).toHaveLength(1);expect(inputs[0]).not.toContain("already accepted human action");
    expect(methods).toEqual(["turn/start","thread/turns/list"]);
  } finally {await client.close();server.stop(true);}
});

test("real Hub: cancelled or expired follow-up cannot receive a normal or new-turn late reply",async()=>{
  const node=handlers(NODE);
  for(const status of ["cancelled","expired"]) {
    const follow=await task(status+" accepted action");expect((await consume(node,follow,"owner-turn")).ok).toBe(true);
    db.run("UPDATE tasks SET status=?2,result='original terminal',completed_at=datetime('now') WHERE task_id=?1",[follow,status]);
    expect((await call(node.get_task,{task_id:follow})).task.status).toBe(status);
    expect((await call(node.send_reply,{in_reply_to:follow,text:"do not deliver"})).error).toBe("reply_task_terminal");
    expect((await call(node.send_reply,{in_reply_to:follow,text:"do not forge late turn",thread_id:THREAD,turn_id:"answer-turn"})).error).toBe("late_reply_context_mismatch");
    expect(row(follow)).toMatchObject({status,result:"original terminal",turn_id:"owner-turn"});
    expect(db.get<any>("SELECT COUNT(*) AS n FROM task_late_replies WHERE task_id=?1",follow).n).toBe(0);
  }
});
