/**
 * Child process for the operation-journal race test: begins the same
 * operation id and prints the outcome. argv: <root> <operation-id> [barrier-dir]
 *
 * With a barrier directory the child announces itself (`ready-<pid>`), then
 * spins until the parent drops a `go` file, so several children enter
 * beginOperation within microseconds of each other instead of being serialised
 * by process start-up time.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginOperation } from "../../src/internal/operation-store.js";

const [root, id, barrier] = process.argv.slice(2);
if (!root || !id) {
  process.stderr.write("usage: begin-operation-child <root> <id> [barrier-dir]\n");
  process.exit(2);
}
if (barrier) {
  writeFileSync(join(barrier, `ready-${process.pid}`), "");
  const go = join(barrier, "go");
  const deadline = Date.now() + 10_000;
  while (!existsSync(go)) {
    if (Date.now() > deadline) {
      process.stderr.write("barrier timeout\n");
      process.exit(3);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}
const res = beginOperation(root, id, {
  resource: "text-to-3d",
  endpoint: "/openapi/v2/text-to-3d",
  apiOrigin: "http://127.0.0.1:1",
  credentialFingerprint: "cred",
  payloadFingerprint: "payload",
});
process.stdout.write(`${JSON.stringify({ outcome: res.outcome, state: res.record.state })}\n`);
