/**
 * Server-Sent Events for task status.
 *
 * The parser follows the WHATWG EventSource algorithm: UTF-8 is decoded
 * across chunk boundaries, lines end at CR, LF or CRLF, an empty line
 * dispatches the event, multi-line `data:` fields are joined with "\n",
 * comment lines (leading ':') are ignored, `id:` and `retry:` are recorded
 * but never used to fabricate a Last-Event-ID we did not receive.
 *
 * Meshy's stream emits `event: message` with the full task JSON (also as the
 * ~10 s keep-alive) and `event: error` with `{message, status_code}` — which
 * can arrive after an HTTP 200, so it is mapped exactly like an HTTP failure.
 */

import { codeForStatus, MeshyApiError } from "../client/errors.js";
import type { TaskEndpoint } from "../client/endpoints/base.js";
import { TaskSchema, isTerminalStatus, type Task } from "../client/types.js";
import { CliError } from "./errors.js";

export const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024;

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
}

export interface SseParser {
  /** Feed raw bytes; returns every event completed by this chunk. */
  feed(chunk: Uint8Array): SseEvent[];
  /** Flush at end of stream (a final event without a trailing blank line is dispatched). */
  end(): SseEvent[];
}

export function createSseParser(opts: { maxEventBytes?: number } = {}): SseParser {
  const maxEventBytes = opts.maxEventBytes ?? DEFAULT_MAX_SSE_EVENT_BYTES;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];
  let lastId: string | null = null;
  let retry: number | null = null;
  let pendingBytes = 0;
  let first = true;

  function dispatch(out: SseEvent[]): void {
    if (dataLines.length === 0) {
      eventType = "";
      pendingBytes = 0;
      return;
    }
    out.push({ event: eventType || "message", data: dataLines.join("\n"), id: lastId, retry });
    eventType = "";
    dataLines = [];
    pendingBytes = 0;
  }

  function processLine(line: string, out: SseEvent[]): void {
    if (line === "") {
      dispatch(out);
      return;
    }
    if (line.startsWith(":")) return; // comment / heartbeat
    let field: string;
    let value: string;
    const colon = line.indexOf(":");
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        pendingBytes += Buffer.byteLength(value, "utf8") + 1;
        if (pendingBytes > maxEventBytes) {
          throw new CliError({ code: "protocol", message: `SSE event exceeds ${maxEventBytes} bytes` });
        }
        dataLines.push(value);
        break;
      case "id":
        if (!value.includes(" ")) lastId = value;
        break;
      case "retry": {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) retry = n;
        break;
      }
      default:
        break; // unknown fields are ignored per spec
    }
  }

  function consume(text: string, out: SseEvent[], final: boolean): void {
    buffer += text;
    if (first && buffer.startsWith("\uFEFF")) buffer = buffer.slice(1);
    first = false;
    let start = 0;
    for (;;) {
      const cr = buffer.indexOf("\r", start);
      const lf = buffer.indexOf("\n", start);
      let end: number;
      let next: number;
      if (cr === -1 && lf === -1) break;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // CR, possibly followed by LF. A trailing CR at the very end of the
        // buffer may be half of a CRLF — wait for more bytes unless final.
        if (cr === buffer.length - 1 && !final) break;
        end = cr;
        next = buffer[cr + 1] === "\n" ? cr + 2 : cr + 1;
      } else {
        end = lf;
        next = lf + 1;
      }
      processLine(buffer.slice(start, end), out);
      start = next;
    }
    buffer = buffer.slice(start);
    if (buffer.length > maxEventBytes) {
      throw new CliError({ code: "protocol", message: `SSE line exceeds ${maxEventBytes} bytes without a line ending` });
    }
  }

  return {
    feed(chunk) {
      const out: SseEvent[] = [];
      consume(decoder.decode(chunk, { stream: true }), out, false);
      return out;
    },
    end() {
      const out: SseEvent[] = [];
      consume(decoder.decode(), out, true);
      if (buffer.length > 0) {
        processLine(buffer, out);
        buffer = "";
      }
      dispatch(out);
      return out;
    },
  };
}

export type StreamEndReason = "terminal" | "timeout" | "idle_timeout" | "disconnected" | "error" | "interrupted" | "protocol";

export interface StreamOutcome {
  reason: StreamEndReason;
  task: Task | null;
  raw: unknown;
  events: number;
  /** Set when the stream carried an API error event or a protocol failure. */
  error: MeshyApiError | CliError | null;
  elapsedMs: number;
}

export interface StreamTaskOptions {
  timeoutMs: number;
  idleTimeoutMs: number;
  signal?: AbortSignal;
  onTask?: (task: Task, raw: unknown) => void | Promise<void>;
  onUnknownEvent?: (event: SseEvent) => void;
  maxEventBytes?: number;
}

/**
 * Open the task stream and consume it until a terminal task, an API error
 * event, a deadline, a disconnect or an abort. The connection is always closed
 * before this resolves.
 */
export async function streamTask(endpoint: TaskEndpoint, taskId: string, opts: StreamTaskOptions): Promise<StreamOutcome> {
  const started = performance.now();
  const total = new AbortController();
  const idle = new AbortController();
  const totalTimer = setTimeout(() => total.abort(new Error("total timeout")), opts.timeoutMs);
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new Error("idle timeout")), opts.idleTimeoutMs);
  };
  const signals: AbortSignal[] = [total.signal, idle.signal];
  if (opts.signal) signals.push(opts.signal);
  const signal = AbortSignal.any(signals);

  const state: { task: Task | null; raw: unknown; events: number } = { task: null, raw: null, events: 0 };
  const finish = (reason: StreamEndReason, error: MeshyApiError | CliError | null = null): StreamOutcome => ({
    reason,
    task: state.task,
    raw: state.raw,
    events: state.events,
    error,
    elapsedMs: performance.now() - started,
  });
  const classifyAbort = (): StreamEndReason => {
    if (opts.signal?.aborted) return "interrupted";
    if (total.signal.aborted) return "timeout";
    if (idle.signal.aborted) return "idle_timeout";
    return "disconnected";
  };

  let handle: Awaited<ReturnType<TaskEndpoint["openStream"]>> | null = null;
  try {
    resetIdle();
    try {
      handle = await endpoint.openStream(taskId, { signal, connectTimeoutMs: Math.min(opts.timeoutMs, opts.idleTimeoutMs) });
    } catch (err) {
      if (signal.aborted) return finish(classifyAbort());
      throw err;
    }
    const contentType = handle.response.headers.get("content-type") ?? "";
    if (!/text\/event-stream/i.test(contentType)) {
      return finish("protocol", new CliError({ code: "protocol", message: `stream endpoint answered with content-type '${contentType || "(none)"}' instead of text/event-stream` }));
    }
    const body = handle.response.body;
    if (!body) return finish("protocol", new CliError({ code: "protocol", message: "stream response has no body" }));
    const reader = body.getReader();
    const parser = createSseParser({ maxEventBytes: opts.maxEventBytes });

    const handleEvent = async (ev: SseEvent): Promise<StreamOutcome | null> => {
      if (ev.event === "error") {
        let payload: { message?: unknown; status_code?: unknown } = {};
        try {
          payload = JSON.parse(ev.data) as typeof payload;
        } catch {
          return finish("protocol", new CliError({ code: "protocol", message: `stream error event is not JSON: ${ev.data.slice(0, 200)}` }));
        }
        const status = typeof payload.status_code === "number" ? payload.status_code : 0;
        const message = typeof payload.message === "string" ? payload.message : "stream error";
        const apiErr = new MeshyApiError({
          message: `meshy stream ${status || "error"} on ${endpoint.streamPath(taskId)}: ${message}`,
          status,
          code: status ? codeForStatus(status) : "server",
          path: endpoint.streamPath(taskId),
          body: payload,
        });
        return finish("error", apiErr);
      }
      if (ev.event !== "message") {
        opts.onUnknownEvent?.(ev);
        return null;
      }
      let json: unknown;
      try {
        json = JSON.parse(ev.data);
      } catch {
        return finish("protocol", new CliError({ code: "protocol", message: `stream message is not JSON: ${ev.data.slice(0, 200)}` }));
      }
      const parsed = TaskSchema.safeParse(json);
      if (!parsed.success) {
        return finish("protocol", new CliError({ code: "protocol", message: `stream message is not a task: ${parsed.error.message}` }));
      }
      state.task = parsed.data;
      state.raw = json;
      state.events += 1;
      await opts.onTask?.(parsed.data, json);
      if (isTerminalStatus(parsed.data.status)) return finish("terminal");
      return null;
    };

    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal.aborted) return finish(classifyAbort());
        return finish("disconnected", new CliError({ code: "network", message: `stream disconnected: ${err instanceof Error ? err.message : String(err)}` }));
      }
      if (signal.aborted) return finish(classifyAbort());
      if (chunk.done) {
        for (const ev of parser.end()) {
          const out = await handleEvent(ev);
          if (out) return out;
        }
        if (state.task === null) return finish("protocol", new CliError({ code: "protocol", message: "stream ended without any task event" }));
        return finish("disconnected", new CliError({ code: "network", message: `stream ended before the task reached a terminal status (last status: ${state.task.status})` }));
      }
      resetIdle(); // any bytes — keep-alives, comments, partial lines — count as liveness
      let parsedEvents: SseEvent[];
      try {
        parsedEvents = parser.feed(chunk.value);
      } catch (err) {
        return finish("protocol", err instanceof CliError ? err : new CliError({ code: "protocol", message: String(err) }));
      }
      for (const ev of parsedEvents) {
        const out = await handleEvent(ev);
        if (out) return out;
      }
    }
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    handle?.close();
  }
}
