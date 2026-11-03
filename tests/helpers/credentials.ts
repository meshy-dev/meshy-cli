import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { profileSecrets, readCredentials, type CredentialProfile } from "../../src/internal/credentials.js";

/**
 * A stored profile opened the way the CLI opens it, after checking that none
 * of its secrets is on disk in the clear.
 */
export function openStoredProfile(file: string, name = "default"): CredentialProfile {
  const raw = readFileSync(file, "utf8");
  const profile = readCredentials(file)?.profiles[name];
  assert.ok(profile, `no profile '${name}' in ${file}`);
  const secrets = profileSecrets(file, profile);
  for (const value of Object.values(secrets)) {
    if (value) assert.ok(!raw.includes(value), `a secret of '${name}' is stored in the clear`);
  }
  return { ...profile, ...secrets };
}
