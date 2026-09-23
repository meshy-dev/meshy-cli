/**
 * ANSI colour for human output.
 *
 * Colour is a property of the destination, not of the command: it is on only
 * when the stream is a terminal, and the environment can always veto. The two
 * conventions every CLI is expected to honour are NO_COLOR (https://no-color.org)
 * and FORCE_COLOR; `TERM=dumb` is the third, for terminals that cannot render
 * escapes at all.
 *
 * `json` and `ndjson` output never passes through here — a machine reading
 * stdout must never receive an escape sequence. Only `pretty` and the human
 * prose on stderr are painted.
 *
 * No dependency: four SGR codes do not justify one.
 */

export type Style = "dim" | "bold" | "red" | "green" | "yellow" | "cyan" | "brand";

const CODES: Record<Style, string> = {
  dim: "2",
  bold: "1",
  red: "31",
  green: "32",
  yellow: "33",
  cyan: "36",
  // Meshy lime (design system `accent-base`, #C5F955) as xterm-256 colour 191,
  // the nearest cube entry; true-colour terminals get the exact hex below.
  brand: "38;5;191",
};

/** The exact brand hex, for terminals that announce 24-bit colour. */
const BRAND_TRUECOLOR = "38;2;197;249;85";

function trueColor(env: ColorEnv): boolean {
  const c = env["COLORTERM"]?.toLowerCase();
  return c === "truecolor" || c === "24bit";
}

export interface ColorEnv {
  NO_COLOR?: string;
  FORCE_COLOR?: string;
  TERM?: string;
  [key: string]: string | undefined;
}

/**
 * FORCE_COLOR wins (except when set to "0"), then NO_COLOR, then a dumb
 * terminal, then whether the stream is actually a TTY.
 */
export function colorEnabled(
  stream: { isTTY?: boolean } = process.stdout,
  env: ColorEnv = process.env,
): boolean {
  const force = env["FORCE_COLOR"];
  if (force !== undefined && force !== "" && force !== "0") return true;
  if (force === "0") return false;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["TERM"] === "dumb") return false;
  return Boolean(stream.isTTY);
}

/** A painter that applies a style, or the identity when colour is off. */
export type Painter = (text: string, style: Style) => string;

export const plain: Painter = (text) => text;

export const painted: Painter = (text, style) =>
  text === "" ? text : `\u001b[${CODES[style]}m${text}\u001b[0m`;

const paintedTrueColor: Painter = (text, style) =>
  style === "brand" && text !== "" ? `\u001b[${BRAND_TRUECOLOR}m${text}\u001b[0m` : painted(text, style);

export function painterFor(
  stream: { isTTY?: boolean } = process.stdout,
  env: ColorEnv = process.env,
): Painter {
  if (!colorEnabled(stream, env)) return plain;
  return trueColor(env) ? paintedTrueColor : painted;
}
