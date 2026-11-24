import { AcpAbortError, AcpClient, AcpError, AcpTimeoutError } from "./acp-client.js";
import {
  readUsageMeta,
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

const ALLOW_KINDS = new Set(["allow_once", "allow_always"]);
const DENY_KINDS = new Set(["reject_once", "reject_always"]);

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
  thoughts: number;
  durationMs: number;
  truncated: boolean;
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
  const startedAt = Date.now();
  const permission = options.permission ?? "deny";
  const timeoutMs = clampTimeout(options.timeoutMs);
  const clientName = options.clientName ?? process.env.PI_VIBE_ACP_CLIENT_NAME ?? "pi";

  let text = "";
  let textTruncated = false;
  let thoughts = 0;
  let usage: AcpUsage | undefined;
  const toolCalls: string[] = [];
  let lastProgressAt = 0;

  const client = createClient(options, permission, {
    onUpdate: (update) => {
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
        if (title && !toolCalls.includes(title)) {
          toolCalls.push(title);
          emit();
        }
        return;
      }
      if (kind === "usage_update") {
        const meta = readUsageMeta(update);
        if (meta?.totalTokens) {
          usage = {
            inputTokens: meta.promptTokens ?? 0,
            outputTokens: meta.completionTokens ?? 0,
            totalTokens: meta.totalTokens,
            cachedReadTokens: meta.cachedTokens,
          };
        }
      }
    },
  });

  function emit(): void {
    if (!options.onProgress) return;
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    options.onProgress({ text, toolCalls: [...toolCalls], usage });
  }

  let sessionId: string | undefined;
  let agent: VibeRunResult["agent"];
  let authMethodCount = 0;

  try {
    const init = await client.initialize({
      name: clientName,
      title: "Pi",
      version: options.clientVersion ?? "unknown",
    });
    agent = { name: init.agentInfo?.name, version: init.agentInfo?.version };
    authMethodCount = init.authMethods?.length ?? 0;

    const session: AcpSessionNewResult = await client.newSession(options.cwd);
    sessionId = session.sessionId;

    const applied = await applyConfig(client, session, {
      mode: options.mode,
      model: options.model,
      thinking: options.thinking,
    });

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
      if (finalUsage && finalUsage.totalTokens) {
        usage = {
          inputTokens: finalUsage.inputTokens,
          outputTokens: finalUsage.outputTokens,
          totalTokens: finalUsage.totalTokens,
          cachedReadTokens: finalUsage.cachedReadTokens,
        };
      }
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
      thoughts,
      durationMs: Date.now() - startedAt,
      truncated: textTruncated,
    };
  } catch (error) {
    // Startup failures (missing binary, no session, a refused option) deserve
    // the same translated message as a failed turn.
    throw explainTurnError(error, authMethodCount);
  } finally {
    if (sessionId) {
      await client.closeSession(sessionId).catch(() => undefined);
    }
    await client.dispose();
  }
}

/** Read Vibe's identity, auth methods, and session options without a prompt. */
export async function readVibeDoctor(
  options: Pick<VibeRunOptions, "cwd" | "command" | "args" | "env" | "clientName" | "clientVersion">,
): Promise<VibeDoctorResult> {
  const client = new AcpClient({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
  });

  let sessionId: string | undefined;
  try {
    const init = await client.initialize({
      name: options.clientName ?? "pi",
      title: "Pi",
      version: options.clientVersion ?? "unknown",
    });
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
  } finally {
    if (sessionId) {
      await client.closeSession(sessionId).catch(() => undefined);
    }
    await client.dispose();
  }
}

function createClient(
  options: VibeRunOptions,
  permission: VibePermission,
  hooks: { onUpdate: (update: AcpSessionUpdate) => void },
): AcpClient {
  return new AcpClient({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    onSessionUpdate: (_sessionId, update) => hooks.onUpdate(update),
    onPermissionRequest: (request) => decidePermission(request, permission, options.confirm),
  });
}

async function decidePermission(
  request: AcpPermissionRequest,
  permission: VibePermission,
  confirm: VibeRunOptions["confirm"],
): Promise<AcpPermissionOutcome> {
  if (permission === "deny") return { outcome: "cancelled" };

  const options = request.options ?? [];
  const allow = options.find((option) => ALLOW_KINDS.has(option.kind ?? ""));
  if (!allow) return { outcome: "cancelled" };

  if (permission === "approve") {
    return { outcome: "selected", optionId: allow.optionId };
  }

  if (!confirm) return { outcome: "cancelled" };
  const title = sanitize(request.toolCall?.title ?? "").trim() || "a tool call";
  const detail = options.find((option) => DENY_KINDS.has(option.kind ?? ""));
  const approved = await confirm({
    title: "Vibe wants to act",
    message: `${title}\n\nApprove once?${detail ? ` (declining picks "${detail.name ?? detail.optionId}")` : ""}`,
  });
  return approved
    ? { outcome: "selected", optionId: allow.optionId }
    : { outcome: "cancelled" };
}

async function applyConfig(
  client: AcpClient,
  session: AcpSessionNewResult,
  wanted: { mode?: string; model?: string; thinking?: string },
): Promise<{ mode?: string; model?: string; thinking?: string }> {
  const applied: { mode?: string; model?: string; thinking?: string } = {};
  const updates: Array<[string, string]> = [];
  if (wanted.mode) updates.push(["mode", wanted.mode]);
  if (wanted.model) updates.push(["model", wanted.model]);
  if (wanted.thinking) updates.push(["thinking", wanted.thinking]);

  let configOptions = session.configOptions ?? [];
  const modes = session.modes?.availableModes ?? [];

  for (const [id, value] of updates) {
    const option = configOptions.find((candidate) => candidate.id === id);
    const allowed =
      id === "mode" && !option
        ? modes.map((mode) => mode.id)
        : (option?.options ?? []).map((choice) => choice.value);

    if (allowed.length > 0 && !allowed.includes(value)) {
      throw new VibeAcpError(
        `vibe has no ${id} "${value}"; available: ${allowed.join(", ")}`,
      );
    }

    const result = await client.setConfigOption(session.sessionId, id, value);
    if (result) configOptions = result;
    applied[id as "mode" | "model" | "thinking"] = value;
  }

  return applied;
}

/** Failure with a message written for the model and the user, not a stack trace. */
export class VibeAcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VibeAcpError";
  }
}

function explainTurnError(error: unknown, authMethodCount: number): Error {
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
