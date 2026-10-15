// #1313 cross-uid control (Docker suite, runs as root).
//
// The provider must report the listener's REAL uid and never assume "mine": a
// shared server owned by another uid is exactly what a reuse decision must
// refuse, and it can only refuse it if the evidence carries the foreign uid.
// This is a real process on a real port started with `setpriv --reuid`, not a mock.
//
// Scope note: this file asserts PROCESS EVIDENCE only. Binding a generation and
// refusing reuse is #1302's job, so no reuse/guard module is imported here.
import { observeHostSharedServe } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-host-shared-observer.ts";

const [url, foreignUidRaw, ownUidRaw] = process.argv.slice(2);
const foreignUid = Number(foreignUidRaw);
const ownUid = Number(ownUidRaw);

const observed = observeHostSharedServe(url);
if (!observed.ok) {
  console.error(`FAIL: observeHostSharedServe(${url}) -> ${observed.reason} (expected a foreign-uid observation)`);
  process.exit(1);
}
const ev = observed.processEvidence;
if (ev.uid !== foreignUid) {
  console.error(`FAIL: evidence uid ${ev.uid}, expected the real foreign uid ${foreignUid}`);
  process.exit(1);
}
if (ev.uid === ownUid) {
  console.error(`FAIL: provider reported our own uid ${ownUid} for a process owned by ${foreignUid}`);
  process.exit(1);
}
if ("generation" in ev) {
  console.error("FAIL: evidence carries a top-level generation claim — argv is diagnostics only");
  process.exit(1);
}
if (typeof ev.diagnostics?.argvContractNote !== "string") {
  console.error("FAIL: diagnostics must explain why the argv shape proves nothing");
  process.exit(1);
}
console.log(`cross-uid ok: uid=${ev.uid} pid=${ev.pid} inode=${ev.listenInode} argvContract=${ev.diagnostics.argvContract} (diagnostic only)`);
