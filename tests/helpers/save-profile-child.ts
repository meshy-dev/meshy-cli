/**
 * Child process used by the credentials concurrency test.
 *
 * Spawned N times in parallel, each instance writes its own profile into the
 * same credentials file. If the lock or the atomic write is wrong, the file ends
 * up corrupt or missing profiles — which is exactly what the test asserts
 * against. Runs as a real process (not a worker) because the lock it exercises
 * is cross-process.
 *
 * argv: <credentials-file> <profile-name>
 */

import { saveProfile } from "../../src/internal/credentials.js";

const [file, name] = process.argv.slice(2);
if (!file || !name) {
  process.stderr.write("usage: save-profile-child <file> <profile>\n");
  process.exit(2);
}

saveProfile(file, name, { kind: "api_key", api_key: `msy_${name}` }, { makeActive: false });
