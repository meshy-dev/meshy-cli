/**
 * OAuth 2.0 + PKCE helpers for the browser-based `meshy auth login` flow.
 *
 * All I/O uses node: builtins only — no new npm dependencies.
 *
 * Flow overview:
 *   1. generateState() + generateCodeVerifier() → random secrets
 *   2. codeChallengeS256(verifier) → S256 challenge
 *   3. buildAuthorizeUrl(...) → URL to open in the browser
 *   4. startCallbackServer(port, expectedState) → loopback HTTP server
 *   5. openBrowser(url) → best-effort platform opener
 *   6. await waitForCallback → { code, state }
 *   7. exchangeCode(...) → { access_token, refresh_token, expires_in, ... }
 *   8. refreshTokens(...) → same shape
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { HintedError } from "./errors.js";
import { USER_AGENT } from "./user-agent.js";

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** 24 random bytes → 32-char base64url string (state parameter). */
export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

/** 32 random bytes → 43-char base64url string (code_verifier). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of the verifier, base64url-encoded (code_challenge, S256 method). */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export interface BuildAuthorizeUrlParams {
  base: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * Builds the authorization URL.
 * Always uses client_id=meshy-cli, response_type=code, code_challenge_method=S256.
 */
export function buildAuthorizeUrl(params: BuildAuthorizeUrlParams): string {
  const url = new URL(params.base);
  url.searchParams.set("client_id", "meshy-cli");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** Escape characters that are special in HTML to prevent reflected XSS. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Loopback callback server
// ---------------------------------------------------------------------------

export interface CallbackResult {
  code?: string;
  state?: string;
}

export interface CallbackServer {
  server: ReturnType<typeof createServer>;
  port: number;
  waitForCallback: Promise<CallbackResult>;
}

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Meshy — Login successful</title></head>
<body>
<h1>Login successful</h1>
<p>You can close this tab and return to the terminal.</p>
</body>
</html>`;

function errorHtml(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Meshy — Login failed</title></head>
<body>
<h1>Login failed</h1>
<p>${escapeHtml(msg)}</p>
<p>Return to the terminal for details.</p>
</body>
</html>`;
}

/**
 * Starts a loopback HTTP server bound to 127.0.0.1 only.
 *
 * Handles ONLY GET /callback; everything else → 404.
 * Falls back to a random port when preferredPort is EADDRINUSE.
 * Closes itself immediately after the first /callback hit.
 * Times out after 5 minutes.
 *
 * State verification happens INSIDE the server: a mismatched state param
 * returns a 400 error page to the browser and rejects waitForCallback, so
 * no success page is ever shown on a state mismatch.
 */
export function startCallbackServer(
  preferredPort: number,
  expectedState: string,
): Promise<CallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    let resolveCallback!: (result: CallbackResult) => void;
    let rejectCallback!: (err: Error) => void;
    const waitForCallback = new Promise<CallbackResult>((res, rej) => {
      resolveCallback = res;
      rejectCallback = rej;
    });

    function settle(result: CallbackResult | Error): void {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      server.close();
      if (result instanceof Error) {
        rejectCallback(result);
      } else {
        resolveCallback(result);
      }
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code") ?? undefined;
      const state = url.searchParams.get("state") ?? undefined;
      const error = url.searchParams.get("error") ?? undefined;
      const errorDescription = url.searchParams.get("error_description") ?? undefined;

      if (error) {
        const msg = errorDescription ?? error;
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml(msg));
        settle(new HintedError({
          message: `Authorization denied: ${msg}`,
          code: "oauth_denied",
          hint: "Run: meshy auth login",
        }));
        return;
      }

      // State verification: reject mismatches before showing any success page.
      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("Login failed: state mismatch — you can close this tab and retry."));
        settle(new HintedError({
          message: "OAuth state mismatch — possible CSRF attack. Run: meshy auth login",
          code: "oauth_state_mismatch",
          hint: "Run: meshy auth login",
        }));
        return;
      }

      // C2: Require a non-empty code. A missing or empty code with no error
      // param means the authorization server sent a malformed response; show
      // the error page (not the success page) so the browser doesn't mislead
      // the user while the terminal fails with oauth_no_code.
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("Login failed: no authorization code received — you can close this tab and retry."));
        settle(new HintedError({
          message: "No authorization code received from the callback.",
          code: "oauth_no_code",
          hint: "Run: meshy auth login",
        }));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      settle({ code, state });
    });

    function tryListen(port: number, fallback: boolean): void {
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;

        // Set up the 5-minute timeout now that the server is up.
        // unref() so the timer doesn't prevent process exit when the test
        // suite finishes (or when the caller abandons the flow).
        timeoutHandle = setTimeout(() => {
          settle(new HintedError({
            message: "Timed out waiting for the browser callback (5 minutes). Run: meshy auth login",
            code: "oauth_timeout",
            hint: "Run: meshy auth login",
          }));
        }, CALLBACK_TIMEOUT_MS);
        timeoutHandle.unref();

        resolveServer({ server, port: actualPort, waitForCallback });
      });

      server.once("error", (err: NodeJS.ErrnoException) => {
        if (!fallback && err.code === "EADDRINUSE") {
          // Port busy — fall back to a random port.
          server.removeAllListeners("error");
          tryListen(0, true);
        } else {
          rejectServer(err);
        }
      });
    }

    tryListen(preferredPort, false);
  });
}

// ---------------------------------------------------------------------------
// Browser opener
// ---------------------------------------------------------------------------

/**
 * Best-effort platform browser opener. Never throws.
 *
 * Env MESHY_CLI_NO_BROWSER=1 forces false (for tests / headless).
 *
 * IMPORTANT — Windows: we do NOT use `cmd /c start "" <url>` because cmd.exe
 * interprets `&` in the OAuth query string as a command separator, breaking
 * the URL and potentially executing arbitrary commands. Instead we spawn
 * rundll32 url.dll,FileProtocolHandler directly with the URL as a plain argv
 * element — no shell involved, no metacharacter risk. The same argv-array
 * approach is used on all platforms (open/xdg-open also receive the URL as a
 * direct argument, never through a shell string).
 *
 * The `_spawnOverride` parameter is a test hook — production callers omit it.
 */
export function openBrowser(
  url: string,
  _spawnOverride?: (cmd: string, args: string[]) => ReturnType<typeof spawn>,
): Promise<boolean> {
  if (process.env["MESHY_CLI_NO_BROWSER"]) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      let cmd: string;
      let args: string[];
      switch (process.platform) {
        case "darwin":
          cmd = "open";
          args = [url];
          break;
        case "win32":
          // rundll32 url.dll,FileProtocolHandler <url> — spawned directly (no
          // shell), so & and other metacharacters in the URL are safe.
          cmd = "rundll32";
          args = ["url.dll,FileProtocolHandler", url];
          break;
        default:
          cmd = "xdg-open";
          args = [url];
      }
      const spawnFn = _spawnOverride ?? ((c: string, a: string[]) =>
        spawn(c, a, { detached: true, stdio: "ignore" })
      );
      const child = spawnFn(cmd, args);
      // B2: Attach an error handler so a missing binary (ENOENT) or other
      // spawn failure resolves false instead of crashing the process with an
      // unhandled 'error' event.
      child.on("error", () => resolve(false));
      child.unref();
      // Defer the optimistic resolve(true) by one microtask tick so the
      // synchronous ENOENT 'error' event (which fires before the next tick)
      // can call resolve(false) first. Once the promise is settled, the
      // deferred resolve(true) is a no-op.
      setImmediate(() => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
  user_id?: string;
}

const TOKEN_TIMEOUT_MS = 30_000;

async function postToken(
  baseUrlV1: string,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const url = `${baseUrlV1}/oauth/token`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HintedError({
      message: `Network error contacting token endpoint: ${err instanceof Error ? err.message : String(err)}`,
      code: "oauth_network",
      hint: "Run: meshy auth login",
    });
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new HintedError({
      message: `Token endpoint returned non-JSON (status ${res.status})`,
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }

  if (!res.ok) {
    const obj = parsed as Record<string, unknown>;
    const msg =
      (typeof obj["error_description"] === "string" ? obj["error_description"] : undefined) ??
      (typeof obj["message"] === "string" ? obj["message"] : undefined) ??
      (typeof obj["error"] === "string" ? obj["error"] : undefined) ??
      `Token endpoint error (status ${res.status})`;
    throw new HintedError({
      message: msg,
      code: "oauth_token_error",
      hint: "Run: meshy auth login",
    });
  }

  const tok = parsed as Record<string, unknown>;

  // Validate access_token.
  if (typeof tok["access_token"] !== "string" || !tok["access_token"]) {
    throw new HintedError({
      message: "Token endpoint response missing access_token",
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }

  // Validate token_type (must be "Bearer", case-insensitive).
  if (
    typeof tok["token_type"] !== "string" ||
    tok["token_type"].toLowerCase() !== "bearer"
  ) {
    throw new HintedError({
      message: `Token endpoint returned unexpected token_type: ${JSON.stringify(tok["token_type"])}`,
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }

  // Validate expires_in (must be a finite positive number — guards against
  // infinite-refresh-loop vectors where a server returns 0 or negative).
  const expiresIn = tok["expires_in"];
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new HintedError({
      message: `Token endpoint returned invalid expires_in: ${JSON.stringify(expiresIn)}`,
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }

  // Validate refresh_token.
  if (typeof tok["refresh_token"] !== "string" || !tok["refresh_token"]) {
    throw new HintedError({
      message: "Token endpoint response missing refresh_token",
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }

  return {
    access_token: tok["access_token"] as string,
    token_type: tok["token_type"] as string,
    expires_in: expiresIn,
    refresh_token: tok["refresh_token"] as string,
    scope: typeof tok["scope"] === "string" ? tok["scope"] : undefined,
    user_id: typeof tok["user_id"] === "string" ? tok["user_id"] : undefined,
  };
}

export interface ExchangeCodeParams {
  baseUrlV1: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(params: ExchangeCodeParams): Promise<TokenResponse> {
  return postToken(params.baseUrlV1, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.codeVerifier,
    client_id: "meshy-cli",
    redirect_uri: params.redirectUri,
  });
}

export interface RefreshTokensParams {
  baseUrlV1: string;
  refreshToken: string;
}

/** Exchange a refresh token for new tokens. */
export async function refreshTokens(params: RefreshTokensParams): Promise<TokenResponse> {
  return postToken(params.baseUrlV1, {
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: "meshy-cli",
  });
}
