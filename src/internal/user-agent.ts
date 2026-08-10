import { VERSION } from "./version.js";

/**
 * Shared User-Agent string for all outbound HTTP requests (API calls and
 * OAuth token exchanges). Format: meshy-cli/0.1.0 (darwin arm64; node v22.1.0)
 */
export const USER_AGENT = `meshy-cli/${VERSION} (${process.platform} ${process.arch}; node ${process.version})`;
