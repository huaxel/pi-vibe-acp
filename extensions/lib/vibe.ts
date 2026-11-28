import { statSync } from "node:fs";
import { AcpAbortError, AcpClient, AcpTimeoutError } from "./acp-client.js";
import {
  readUsageMeta,
  supportsSessionClose,
  type AcpConfigOption,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpSessionNewResult,
  type AcpSessionUpdate,
  type AcpUsage,
} from "./protocol.js";

/** How this client answers Vibe's tool-permission requests. */
export type VibePermission = "deny" | "ask" | "approve";

export const VIBE_PERMISSIONS: readonly VibePermission[] = ["deny", "ask", "approve"];

const DEFAULT_TIMEOUT_MS = 900_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 3_600_000;
const TEXT_LIMIT = 60_000;
const PROGRESS_INTERVAL_MS = 120;

// Vibe also uses allow_always for permanent grants. Only fall back to known
// session-scoped IDs, never to an arbitrary option of that kind.
const SESSION_GRANT_IDS = new Set([
  "allow_always",
  "allow_session_exact",
  "allow_session_directory_recursive",
]);

export interface VibeProgress {
  text: string;
  toolCalls: string[];
  usage?: AcpUsage;
}

export interface VibeRunResult extends VibeProgress {
  sessionId?: string;
  stopReason: string;
  cancelled: boolean;
  agent?: { name?: string; version?: string };
  applied: { mode?: string; model?: string; thinking?: string };
  /** Options Vibe accepted but set to something other than what was requested. */
  adjusted?: VibeAdjustment[];
  thoughts: number;
  durationMs: number;
  truncated: boolean;
}

export interface VibeAdjustment {
  option: "mode" | "model" | "thinking";
  requested: string;
  applied: string;
}

export interface VibeRunOptions {
  cwd: string;
  prompt: string;
  /** Vibe approval policy (`ask`, `accept-edits`, `smart-approve`, `auto-approve`). */
  mode?: string;
  model?: string;
  thinking?: string;
  permission?: VibePermission;
  timeoutMs?: number;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  clientName?: string;
  clientVersion?: string;
  signal?: AbortSignal;
  /** Grace window for an agent to acknowledge a cancel. Defaults to 5s. */
  abortGraceMs?: number;
  onProgress?: (progress: VibeProgress) => void;
  /** Called for each permission request when `permission` is "ask". */
  confirm?: (request: { title: string; message: string }) => Promise<boolean>;
}

export interface VibeDoctorResult {
  agent?: { name?: string; version?: string; title?: string };
  protocolVersion: number;
  authMethods: string[];
  configOptions: AcpConfigOption[];
}

/**
 * Run one task through Vibe's own agent loop over ACP.
 *
 * The model calls belong to Vibe, not to Pi: this returns Vibe's token counts
 * in `usage` for reporting, deliberately not as Pi's `usage` field, so Pi's own
 * accounting never claims tokens it did not buy.
 */
export async function runVibeTask(options: VibeRunOptions): Promise<VibeRunResult> {
  assertDirectory(options.cwd);
  const startedAt = Date.now();
  const permission = options.permission ?? "deny";
  const timeoutMs = clampTimeout(options.timeoutMs);
  const clientName = options.clientName ?? process.env.PI_VIBE_ACP_CLIENT_NAME ?? "pi";

  let text = "";
  let textTruncated = false;
  let thoughts = 0;
  let usage: AcpUsage | undefined;
  const toolCalls: string[] = [];
  const toolTitles = new Map<string, string>();
  let lastProgressAt = 0;

  let client: AcpClient | undefined;
  const hooks = {
    sessionId: () => sessionId,
    toolTitle: (id: string) => toolTitles.get(id),
    onUpdate: (update: AcpSessionUpdate) => {
      const kind = update.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const chunk = sanitize(update.content?.text ?? "");
        if (!chunk) return;
        if (text.length < TEXT_LIMIT) {
          text += chunk;
          if (text.length > TEXT_LIMIT) {
            text = text.slice(0, TEXT_LIMIT);
            textTruncated = true;
          }
        } else {
          textTruncated = true;
        }
        emit();
        return;
      }
      if (kind === "agent_thought_chunk") {
        thoughts += 1;
        return;
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const title = sanitize(update.title ?? "").trim();
        if (title && update.toolCallId) toolTitles.set(update.toolCallId, title);
        if (title && !toolCalls.includes(title)) {
          toolCalls.push(title);
          emit();
        }
        return;
      }
      if (kind === "usage_update") {
        const meta = readUsageMeta(update);
        if (meta) {
          // Some agents report counts without a total; keep the report instead of
          // discarding it.
          usage = mergeUsage(usage, {
            inputTokens: meta.promptTokens,
            outputTokens: meta.completionTokens,
            totalTokens: meta.totalTokens,
            cachedReadTokens: meta.cachedTokens,
          });
        }
        return;
      }
    },
  };

  function emit(): void {
    if (!options.onProgress) return;
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    options.onProgress({ text, toolCalls: [...toolCalls], usage });
  }

  let sessionId: string | undefined;
  let agent: VibeRunResult["agent"];
  let applied: VibeRunResult["applied"] = {};
  let adjusted: VibeAdjustment[] = [];
  let authMethodCount = 0;
  let closeSupported = false;

  try {
    // Already cancelled: report it without starting an agent just to kill it.
    if (options.signal?.aborted) throw new AcpAbortError("initialize");
    client = createClient(options, permission, hooks);
    const init = await client.initialize(
      {
        name: clientName,
        title: "Pi",
        version: options.clientVersion ?? "unknown",
      },
      { signal: options.signal },
    );
    agent = { name: init.agentInfo?.name, version: init.agentInfo?.version };
    authMethodCount = init.authMethods?.length ?? 0;
    closeSupported = supportsSessionClose(init);

    const session: AcpSessionNewResult = await client.newSession(options.cwd, {
      signal: options.signal,
    });
    sessionId = session.sessionId;

    ({ applied, adjusted } = await applyConfig(
      client,
      session,
      {
        mode: options.mode,
        model: options.model,
        thinking: options.thinking,
      },
      { signal: options.signal },
    ));

    let stopReason = "end_turn";
    let cancelled = false;
    try {
      const result = await client.prompt(sessionId, options.prompt, {
        signal: options.signal,
        timeoutMs,
      });
      stopReason = result.stopReason ?? "end_turn";
      cancelled = stopReason === "cancelled";
      const finalUsage = result.usage;
      if (finalUsage) usage = mergeUsage(usage, finalUsage);
    } catch (error) {
      if (!(error instanceof AcpAbortError)) throw error;
      stopReason = "cancelled";
      cancelled = true;
    }

    return {
      text: text.trim(),
      toolCalls,
      usage,
      sessionId,
      stopReason,
      cancelled,
      agent,
      applied,
      adjusted: adjusted.length ? adjusted : undefined,
      thoughts,
      durationMs: Date.now() - startedAt,
      truncated: textTruncated,
    };
  } catch (error) {
    // A cancel before the turn starts has no text or stop reason to report, but
    // it is still a cancellation, not a failure.
    if (error instanceof AcpAbortError) {
      return {
        text: text.trim(),
        toolCalls,
        usage,
        sessionId,
        stopReason: "cancelled",
        cancelled: true,
        agent,
        applied,
        adjusted: adjusted.length ? adjusted : undefined,
        thoughts,
        durationMs: Date.now() - startedAt,
        truncated: textTruncated,
      };
    }
    // Startup failures (missing binary, no session, a refused option) deserve
    // the same translated message as a failed turn.
    throw explainTurnError(error, authMethodCount);
  } finally {
    if (sessionId && closeSupported) {
      await client?.closeSession(sessionId).catch(() => undefined);
    }
    await client?.dispose();
  }
}

/** Read Vibe's identity, auth methods, and session options without a prompt. */
export async function readVibeDoctor(
  options: Pick<VibeRunOptions, "cwd" | "command" | "args" | "env" | "clientName" | "clientVersion">,
): Promise<VibeDoctorResult> {
  assertDirectory(options.cwd);

  let client: AcpClient | undefined;
  let sessionId: string | undefined;
  let closeSupported = false;
  let authMethodCount = 0;
  try {
    client = new AcpClient({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    });
    const init = await client.initialize({
      name: options.clientName ?? "pi",
      title: "Pi",
      version: options.clientVersion ?? "unknown",
    });
    closeSupported = supportsSessionClose(init);
    authMethodCount = init.authMethods?.length ?? 0;
    const session = await client.newSession(options.cwd);
    sessionId = session.sessionId;
    return {
      agent: {
        name: init.agentInfo?.name,
        title: init.agentInfo?.title,
        version: init.agentInfo?.version,
      },
      protocolVersion: init.protocolVersion,
      authMethods: (init.authMethods ?? []).map((method) => method.id),
      configOptions: session.configOptions ?? [],
    };
  } catch (error) {
    // Same translation as a run: a missing binary needs the install hint here too.
    throw explainTurnError(error, authMethodCount);
  } finally {
    if (sessionId && closeSupported) {
      await client?.closeSession(sessionId).catch(() => undefined);
    }
    await client?.dispose();
  }
}

/** A missing cwd makes spawn fail with ENOENT, which reads as a missing binary. */
export function assertDirectory(cwd: string): void {
  try {
    if (statSync(cwd).isDirectory()) return;
  } catch {
    throw new VibeAcpError(`working directory "${cwd}" does not exist`);
  }
  throw new VibeAcpError(`working directory "${cwd}" is not a directory`);
}

function createClient(
  options: VibeRunOptions,
  permission: VibePermission,
  hooks: {
    sessionId: () => string | undefined;
    toolTitle: (id: string) => string | undefined;
    onUpdate: (update: AcpSessionUpdate) => void;
  },
): AcpClient {
  return new AcpClient({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    abortGraceMs: options.abortGraceMs,
    onSessionUpdate: (sessionId, update) => {
      if (sessionId === hooks.sessionId()) hooks.onUpdate(update);
    },
    onPermissionRequest: (request) => {
      if (!request?.sessionId || request.sessionId !== hooks.sessionId() || options.signal?.aborted) {
        return { outcome: "cancelled" };
      }
      return decidePermission(request, permission, options.confirm, hooks.toolTitle, options.signal);
    },
  });
}

export async function decidePermission(
  request: AcpPermissionRequest,
  permission: VibePermission,
  confirm: VibeRunOptions["confirm"],
  toolTitle: (id: string) => string | undefined,
  signal?: AbortSignal,
): Promise<AcpPermissionOutcome> {
  if (permission === "deny") return { outcome: "cancelled" };

  const options = request.options ?? [];
  // Prefer the narrowest grant: an agent that lists allow_always first must not
  // get a session-wide approval behind a dialog that promised "once".
  const allowOnce = options.find((option) => option.kind === "allow_once");
  const allow = allowOnce ?? options.find(
    (option) => option.kind === "allow_always" && SESSION_GRANT_IDS.has(option.optionId),
  );
  if (!allow) return { outcome: "cancelled" };

  if (permission === "approve") {
    return { outcome: "selected", optionId: allow.optionId };
  }

  if (!confirm) return { outcome: "cancelled" };
  const call = request.toolCall;
  const title = sanitize(call?.title ?? "").trim() ||
    (call?.toolCallId && toolTitle(call.toolCallId));
  if (!title) return { outcome: "cancelled" };
  const scope = allowOnce
    ? "Approve once?"
    : `Approve for this session? ("${sanitize(allow.name ?? allow.optionId)}")`;
  const approved = await confirm({
    title: "Vibe wants to act",
    message: `${title}\n\n${scope}`,
  });
  return approved && !signal?.aborted
    ? { outcome: "selected", optionId: allow.optionId }
    : { outcome: "cancelled" };
}

export async function applyConfig(
  client: AcpClient,
  session: AcpSessionNewResult,
  wanted: { mode?: string; model?: string; thinking?: string },
  requestOptions: { signal?: AbortSignal } = {},
): Promise<{ applied: VibeRunResult["applied"]; adjusted: VibeAdjustment[] }> {
  const applied: VibeRunResult["applied"] = {};
  const adjusted: VibeAdjustment[] = [];
  const updates: Array<[VibeAdjustment["option"], string]> = [];
  if (wanted.mode) updates.push(["mode", wanted.mode]);
  if (wanted.model) updates.push(["model", wanted.model]);
  if (wanted.thinking) updates.push(["thinking", wanted.thinking]);

  let configOptions = session.configOptions ?? [];
  const modes = session.modes?.availableModes ?? [];

  for (const [id, value] of updates) {
    const option = configOptions.find((candidate) => candidate.id === id);
    // Mode has two homes in ACP: a `mode` config option (what Vibe exposes), or
    // the dedicated session/set_mode + modes list. Route to whichever exists.
    const viaSessionMode = id === "mode" && !option && modes.length > 0;
    const allowed = viaSessionMode
      ? modes.map((mode) => mode.id)
      : (option?.options ?? []).map((choice) => choice.value);

    if (allowed.length > 0 && !allowed.includes(value)) {
      throw new VibeAcpError(
        `vibe has no ${id} "${value}"; available: ${allowed.join(", ")}`,
      );
    }

    if (viaSessionMode) {
      await client.setSessionMode(session.sessionId, value, requestOptions);
      applied[id] = value;
    } else {
      const result = await client.setConfigOption(
        session.sessionId,
        id,
        value,
        requestOptions,
      );
      if (result) configOptions = result;
      // The agent may adjust the value it accepted; its response is authoritative,
      // so report what actually stuck rather than what was asked for, and record
      // the difference so the caller can say so.
      const confirmed = result?.find((candidate) => candidate.id === id)?.currentValue;
      const actual = typeof confirmed === "string" ? confirmed : value;
      applied[id] = actual;
      if (actual !== value) adjusted.push({ option: id, requested: value, applied: actual });
    }
  }

  return { applied, adjusted };
}

/**
 * Usage arrives as reports carrying a total, per-side counts, or both. Vibe's are
 * session-cumulative, so the newest per-side counts win; fields a report omits
 * keep their last value, and the total never shrinks.
 */
export function mergeUsage(
  previous: AcpUsage | undefined,
  next: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedReadTokens?: number;
  },
): AcpUsage | undefined {
  const inputTokens = next.inputTokens ?? previous?.inputTokens ?? 0;
  const outputTokens = next.outputTokens ?? previous?.outputTokens ?? 0;
  const totalTokens = Math.max(
    next.totalTokens ?? 0,
    inputTokens + outputTokens,
    previous?.totalTokens ?? 0,
  );
  if (!totalTokens) return previous;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedReadTokens: next.cachedReadTokens ?? previous?.cachedReadTokens,
  };
}

/** Failure with a message written for the model and the user, not a stack trace. */
export class VibeAcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VibeAcpError";
  }
}

export function explainTurnError(error: unknown, authMethodCount: number): Error {
  if (error instanceof VibeAcpError) return error;
  if (error instanceof AcpTimeoutError) {
    return new VibeAcpError(
      `${error.message}. The turn keeps running inside Vibe unless the process was killed; ` +
        "raise timeoutSeconds for long tasks.",
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found/i.test(message)) {
    return new VibeAcpError(
      `vibe-acp is not installed or not on PATH (${message}). Install Mistral Vibe ` +
        "(uv tool install mistral-vibe) or point VIBE_ACP_BIN at the binary.",
    );
  }
  if (/auth|api key|sign in|credential|401/i.test(message)) {
    return new VibeAcpError(
      `${message}. Vibe is not signed in: run "vibe --setup" once, or export MISTRAL_API_KEY.` +
        (authMethodCount > 0 ? ` (agent advertised auth methods: ${authMethodCount})` : ""),
    );
  }
  return new VibeAcpError(message);
}

/** Floor lives in the tool schema (5s); this only guards against nonsense. */
function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)));
}

// Two escape families matter in practice: OSC (`ESC ] … BEL/ST`, used for
// titles and hyperlinks) and CSI (`ESC [ params final`). Anything else is
// handled by the control-character strip in stripAnsi().
const ANSI_PATTERN =
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(ANSI_PATTERN, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function sanitize(text: string): string {
  return stripAnsi(text);
}
