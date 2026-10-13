const seam=process.env.SEAM;
const p=seam==="request"?"/repo/agent-node/src/cli.ts":"/repo/server/src/human-inbox.ts";
const anchor=seam==="auth"?'meta.auth_origin === "user"':seam==="depth"?"if (page.length < 256) break;":"limit: 20, human_first: true";
const replacement=seam==="auth"?"true":seam==="depth"?"if (true) break;":"limit: 20, human_first: false";
const s=await Bun.file(p).text();
if(s.split(anchor).length!==2)throw Error("mutation anchor "+seam);
await Bun.write(p,s.replace(anchor,replacement));
