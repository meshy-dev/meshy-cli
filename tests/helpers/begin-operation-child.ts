/**
 * Child process for the operation-journal race test: begins the same
 * operation id and prints the outcome. argv: <root> <operation-id>
 */
import { beginOperation } from "../../src/internal/operation-store.js";

const [root, id] = process.argv.slice(2);
if (!root || !id) {
  process.stderr.write("usage: begin-operation-child <root> <id>\n");
  process.exit(2);
}
const res = beginOperation(root, id, {
  resource: "text-to-3d",
  endpoint: "/openapi/v2/text-to-3d",
  apiOrigin: "http://127.0.0.1:1",
  credentialFingerprint: "cred",
  payloadFingerprint: "payload",
});
process.stdout.write(`${JSON.stringify({ outcome: res.outcome, state: res.record.state })}\n`);
