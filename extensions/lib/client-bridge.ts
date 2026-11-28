/**
 * Maps ACP client tools onto Pi tool calls.
 *
 * When this client advertises `fs.writeTextFile` or `terminal`, Vibe stops doing
 * that work itself and calls us instead. Answering directly would make Pi a
 * silent proxy with more authority than its own tools, so instead the request is
 * parked, turned into a real Pi `toolCall`, and only answered once Pi has run it
 * — with Pi's approval posture, sandbox, and rendering. This is the same
 * inversion `pi-agy` performs on agy's tools, expressed through ACP's own
 * delegation methods instead of an MCP bridge.
 *
 * Reads are deliberately not bridged: ACP has no "read only this much" contract,
 * Pi's `read` truncates at 50KB, and content truncated on the way to the model
 * could be written back over the real file. Vibe keeps its own read tool.
 */

import { randomBytes } from "node:crypto";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { CLIENT_METHODS } from "./protocol.js";
import type { DeferredClientRequest } from "./acp-client.js";

/** A client-tool request waiting on a Pi tool result. */
export interface ParkedCall {
  /** Shadow `toolCallId`: what Pi's transcript carries and what we match on. */
  id: string;
  /** Pi tool to run in Vibe's place. */
  tool: string;
  arguments: JsonObject;
  /** The ACP request to answer once Pi reports back. */
  deferred: DeferredClientRequest;
  method: string;
  /** Registry key for `terminal/create`; unused by the others. */
  terminalId?: string;
}

export type BridgeDecision =
  | { kind: "call"; call: ParkedCall }
  | { kind: "immediate"; result: unknown; error?: string };

/** What one finished terminal left behind, for `output` and `wait_for_exit`. */
interface TerminalRecord {
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
}

/**
 * Results of commands Pi already ran, keyed by the terminal id we minted.
 *
 * ACP terminals are stateful (create → wait → output → release) while a Pi tool
 * call is one-shot, so the command runs to completion inside the Pi turn and the
 * remaining calls answer from this table. `kill` finds a finished process, which
 * is the honest outcome of a cancel: there is nothing left to signal.
 */
/** Enough for concurrent commands, small enough that a leak stays small. */
const MAX_TERMINALS = 64;

export class TerminalRegistry {
  private readonly records = new Map<string, TerminalRecord>();

  mint(): string {
    return `vibeterm-${randomBytes(8).toString("hex")}`;
  }

  set(terminalId: string, record: TerminalRecord): void {
    // Agents are not obliged to release, so evict the oldest record instead of
    // holding every command's output for the life of the session.
    if (!this.records.has(terminalId) && this.records.size >= MAX_TERMINALS) {
      const oldest = this.records.keys().next();
      if (!oldest.done) this.records.delete(oldest.value);
    }
    this.records.set(terminalId, record);
  }

  read(terminalId: string): TerminalRecord {
    // An unknown id is a cancel path or a stale reference, not a protocol
    // violation: report an empty, already-finished terminal rather than failing.
    return this.records.get(terminalId) ?? { output: "", truncated: false, exitCode: null, signal: null };
  }

  release(terminalId: string): void {
    this.records.delete(terminalId);
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * Decide what a client-tool request becomes: a Pi tool call, or an answer that
 * needs no Pi involvement.
 */
export function planClientRequest(input: {
  method: string;
  params: Record<string, unknown>;
  deferred: DeferredClientRequest;
  terminals: TerminalRegistry;
}): BridgeDecision {
  const { method, params, deferred, terminals } = input;

  if (method === CLIENT_METHODS.fsWriteTextFile) {
    const path = typeof params.path === "string" ? params.path : "";
    const content = params.content;
    // A malformed write must fail loudly. Answering success would tell the agent
    // a file it never wrote is on disk, and coercing `content` to "" would
    // truncate the real file to zero bytes.
    if (!path || typeof content !== "string") {
      return {
        kind: "immediate",
        result: undefined,
        error: `${method} needs a path and string content`,
      };
    }
    return {
      kind: "call",
      call: {
        id: shadowId(),
        tool: "write",
        arguments: { path, content },
        deferred,
        method,
      },
    };
  }

  if (method === CLIENT_METHODS.terminalCreate) {
    const terminalId = terminals.mint();
    return {
      kind: "call",
      call: {
        id: shadowId(),
        tool: "bash",
        arguments: { command: buildCommand(params) },
        deferred,
        method,
        terminalId,
      },
    };
  }

  if (method === CLIENT_METHODS.terminalWaitForExit) {
    const record = terminals.read(stringParam(params.terminalId));
    return { kind: "immediate", result: { exitCode: record.exitCode, signal: record.signal } };
  }

  if (method === CLIENT_METHODS.terminalOutput) {
    const record = terminals.read(stringParam(params.terminalId));
    return { kind: "immediate", result: { output: record.output, truncated: record.truncated } };
  }

  if (method === CLIENT_METHODS.terminalKill) {
    // The command already finished inside its Pi turn, so there is no live
    // process to signal. Answering success keeps Vibe's cancel path moving.
    return { kind: "immediate", result: {} };
  }

  if (method === CLIENT_METHODS.terminalRelease) {
    terminals.release(stringParam(params.terminalId));
    return { kind: "immediate", result: {} };
  }

  // `fs/read_text_file` is never advertised, so this is a misbehaving agent.
  return { kind: "immediate", result: undefined };
}

/**
 * Answer a parked request from the Pi tool result, translating Pi's one-shot
 * result into the shape ACP asked for.
 */
export function settleClientResult(input: {
  call: ParkedCall;
  result: ToolResultMessage;
  terminals: TerminalRegistry;
}): void {
  const { call, result, terminals } = input;

  if (call.method === CLIENT_METHODS.fsWriteTextFile) {
    if (result.isError) {
      call.deferred.fail(toolResultText(result) || "write failed");
      return;
    }
    // ACP's write response is empty; the write itself is the result.
    call.deferred.settle({});
    return;
  }

  if (call.method === CLIENT_METHODS.terminalCreate) {
    const outcome = readTerminalOutcome(result);
    if (call.terminalId) {
      terminals.set(call.terminalId, outcome);
    }
    // The command ran (possibly badly). Report it as a finished terminal and let
    // Vibe read the exit code, which is how it decides success on its own.
    call.deferred.settle({ terminalId: call.terminalId });
    return;
  }

  // Nothing else parks, but never leave an agent waiting if it does.
  call.deferred.settle({});
}

/**
 * Read a finished Pi `bash` result as a terminal outcome.
 *
 * Pi appends `Command exited with code N` to a failing result and sets
 * `isError`; a successful one carries no marker. Parsing the marker is the only
 * way to recover the exact code, and a failure with an unreadable marker stays
 * non-zero so Vibe cannot mistake it for success.
 */
export function readTerminalOutcome(result: ToolResultMessage): {
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
} {
  const raw = toolResultText(result);
  // Pi's bash tool caps output and replaces the tail with a marker naming the
  // saved file. Passing that on as ordinary output would tell the agent it has
  // the whole result when it does not.
  const truncation = /\n\n\[Showing lines \d+-\d+ of \d+ \([^)]*\)\.[^\]]*\]\s*$/.exec(raw);
  const text = truncation ? raw.slice(0, truncation.index) : raw;
  // Pi separates the marker with a blank line only when there is output, so an
  // empty failing command starts with it.
  const marker = /(?:^|\n\n)Command exited with code (-?\d+)\s*$/.exec(text);
  const output = marker ? text.slice(0, marker.index) : text;
  const exitCode = marker
    ? Number(marker[1])
    : result.isError
      ? 1
      : 0;
  return { output, truncated: truncation !== null, exitCode, signal: null };
}

export function toolResultText(result: ToolResultMessage): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

/** Build the shell line Pi's `bash` tool will run for one ACP terminal. */
export function buildCommand(params: Record<string, unknown>): string {
  const command = stringParam(params.command);
  const args = Array.isArray(params.args) ? params.args.map((arg) => String(arg)) : [];
  const env = Array.isArray(params.env)
    ? params.env
        .map((entry) => entry as { name?: unknown; value?: unknown })
        .filter((entry) => typeof entry.name === "string" && entry.name.length > 0)
        .map((entry) => `${String(entry.name)}=${String(entry.value ?? "")}`)
    : [];

  const parts: string[] = [];
  const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : undefined;
  if (cwd) parts.push(`cd ${shellQuote(cwd)} &&`);
  // `env` applies the variables to the command itself, so the caller's shell
  // profile cannot drop or reorder them.
  if (env.length > 0) parts.push("env", ...env.map((entry) => shellQuote(entry)));
  parts.push(shellQuote(command));
  for (const arg of args) parts.push(shellQuote(arg));
  return parts.join(" ");
}

function shellQuote(value: string): string {
  if (value === "") return "''";
  // Safe unquoted: no metacharacters, no leading tilde or dash surprises for args.
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shadowId(): string {
  return `vibebridge-${randomBytes(8).toString("hex")}`;
}
