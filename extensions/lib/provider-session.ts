import { createHash } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { AcpAbortError, AcpClient } from "./acp-client.js";
import {
  readUsageMeta,
  supportsSessionClose,
  type AcpConfigOption,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpSessionMode,
  type AcpSessionUpdate,
  type AcpUsage,
} from "./protocol.js";
import {
  applyConfig,
  assertDirectory,
  decidePermission,
  explainTurnError,
  mergeUsage,
  stripAnsi,
  type VibePermission,
} from "./vibe.js";

export interface ConversationSyncState {
  systemPrompt: string;
  syncedInputCount: number;
  syncedInputFingerprint: string;
  syncedAssistantFingerprint: string;
}

export interface VibeProviderTurnOptions {
  cwd: string;
  messages: readonly Message[];
  systemPrompt?: string;
  model: string;
  thinking?: string;
  mode?: string;
  permission: VibePermission;
  timeoutMs?: number;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  clientName?: string;
  clientVersion?: string;
  signal?: AbortSignal;
  abortGraceMs?: number;
  confirm?: (request: { title: string; message: string }) => Promise<boolean>;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolActivity?: (title: string) => void;
}

export interface VibeProviderTurnResult {
  sessionId: string;
  stopReason: string;
  cancelled: boolean;
  reusedSession: boolean;
  text: string;
  thinking: string;
  usageDelta?: AcpUsage;
  cumulativeUsage?: AcpUsage;
  applied: { mode?: string; model?: string; thinking?: string };
  commitSync: (assistantMessage: AssistantMessage) => void;
}

export interface WarmSessionInfo {
  sessionId: string;
  cwd: string;
  applied: { mode?: string; model?: string; thinking?: string };
  cumulativeUsage?: AcpUsage;
}

interface ActiveTurnCallbacks {
  onUpdate: (update: AcpSessionUpdate) => void;
  onPermission: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
}

interface WarmSession {
  client: AcpClient;
  sessionId: string;
  cwd: string;
  closeSupported: boolean;
  authMethodCount: number;
  configOptions: AcpConfigOption[];
  modes: AcpSessionMode[];
  /**
   * Model and thinking levels as persisted before this session touched them.
   * Vibe has no session-scoped model option, so applying one rewrites
   * `~/.vibe/config.toml`; this snapshot is restored on close.
   */
  initial?: { model?: string; thinking?: string };
  applied: { mode?: string; model?: string; thinking?: string };
  cumulativeUsage?: AcpUsage;
  sync?: ConversationSyncState;
  active?: ActiveTurnCallbacks;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 900_000;

/**
 * Manages warm `vibe-acp` sessions keyed by working directory so multi-turn Pi
 * conversations reuse Vibe's live session and only send incremental deltas.
 */
export class VibeSessionPool {
  private readonly sessions = new Map<string, WarmSession>();
  /** Per-workspace turn chain: one ACP session cannot serve two prompts at once. */
  private readonly queues = new Map<string, Promise<unknown>>();

  getStatus(cwd: string): WarmSessionInfo | undefined {
    const session = this.sessions.get(cwd);
    if (!session) return undefined;
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      applied: { ...session.applied },
      cumulativeUsage: session.cumulativeUsage ? { ...session.cumulativeUsage } : undefined,
    };
  }

  async reset(cwd?: string): Promise<void> {
    if (cwd !== undefined) {
      const session = this.sessions.get(cwd);
      this.sessions.delete(cwd);
      if (session) await disposeSession(session);
      return;
    }
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((session) => disposeSession(session)));
  }

  async runTurn(options: VibeProviderTurnOptions): Promise<VibeProviderTurnResult> {
    // Concurrent turns on one workspace (parallel subagents in the same cwd)
    // would otherwise prompt a single ACP session at once, where each turn's
    // update callback clobbers the other's and the agent refuses the second
    // prompt. Serialize them instead of interleaving.
    const previous = this.queues.get(options.cwd) ?? Promise.resolve();
    const turn = previous
      .catch(() => undefined)
      .then(() => this.runTurnNow(options));
    const settled = turn.catch(() => undefined);
    this.queues.set(options.cwd, settled);
    try {
      return await turn;
    } finally {
      if (this.queues.get(options.cwd) === settled) this.queues.delete(options.cwd);
    }
  }

  private async runTurnNow(options: VibeProviderTurnOptions): Promise<VibeProviderTurnResult> {
    assertDirectory(options.cwd);
    if (options.signal?.aborted) throw new AcpAbortError("prompt");

    const systemPrompt = options.systemPrompt?.trim() ?? "";
    const existing = this.sessions.get(options.cwd);
    const canReuse = existing !== undefined && canContinueSession(existing, systemPrompt, options.messages);

    let session: WarmSession;
    let promptText: string;
    let reusedSession = false;

    if (canReuse && existing.sync) {
      session = existing;
      reusedSession = true;
      const deltaMessages = options.messages.slice(existing.sync.syncedInputCount + 1);
      promptText = renderDeltaPrompt(deltaMessages);
    } else {
      if (existing) {
        this.sessions.delete(options.cwd);
        await disposeSession(existing);
      }
      session = await this.createSession(options);
      this.sessions.set(options.cwd, session);
      promptText = renderColdPrompt(systemPrompt, options.messages);
    }

    const previousUsage = session.cumulativeUsage;
    let latestUsage = previousUsage;
    let text = "";
    let thinking = "";
    const toolTitles = new Map<string, string>();

    session.active = {
      onUpdate: (update) => {
        const kind = update.sessionUpdate;
        if (kind === "agent_message_chunk") {
          const chunk = stripAnsi(update.content?.text ?? "");
          if (!chunk) return;
          text += chunk;
          options.onTextDelta?.(chunk);
          return;
        }
        if (kind === "agent_thought_chunk") {
          const chunk = stripAnsi(update.content?.text ?? "");
          if (!chunk) return;
          thinking += chunk;
          options.onThinkingDelta?.(chunk);
          return;
        }
        if (kind === "tool_call" || kind === "tool_call_update") {
          const title = stripAnsi(update.title ?? "").trim();
          if (title && update.toolCallId) toolTitles.set(update.toolCallId, title);
          if (title) options.onToolActivity?.(title);
          return;
        }
        if (kind === "usage_update") {
          const meta = readUsageMeta(update);
          if (meta) {
            latestUsage = mergeUsage(latestUsage, {
              inputTokens: meta.promptTokens,
              outputTokens: meta.completionTokens,
              totalTokens: meta.totalTokens,
              cachedReadTokens: meta.cachedTokens,
            });
          }
        }
      },
      onPermission: async (request) => {
        if (!request?.sessionId || request.sessionId !== session.sessionId || options.signal?.aborted) {
          return { outcome: "cancelled" };
        }
        return decidePermission(
          request,
          options.permission,
          options.confirm,
          (id) => toolTitles.get(id),
          options.signal,
        );
      },
    };

    try {
      const wanted: { mode?: string; model?: string; thinking?: string } = {};
      if (options.mode && options.mode !== session.applied.mode) wanted.mode = options.mode;
      if (options.model && options.model !== session.applied.model) wanted.model = options.model;
      if (options.thinking && options.thinking !== session.applied.thinking) {
        wanted.thinking = options.thinking;
      }

      if (wanted.mode || wanted.model || wanted.thinking) {
        const { applied } = await applyConfig(
          session.client,
          {
            sessionId: session.sessionId,
            configOptions: session.configOptions,
            modes: session.modes.length ? { availableModes: session.modes } : undefined,
          },
          wanted,
          { signal: options.signal },
        );
        session.applied = { ...session.applied, ...applied };
      }

      let stopReason = "end_turn";
      let cancelled = false;
      try {
        const result = await session.client.prompt(session.sessionId, promptText, {
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        });
        stopReason = result.stopReason ?? "end_turn";
        cancelled = stopReason === "cancelled";
        if (result.usage) latestUsage = mergeUsage(latestUsage, result.usage);
      } catch (error) {
        if (!(error instanceof AcpAbortError)) throw error;
        stopReason = "cancelled";
        cancelled = true;
      }

      const usageDelta = subtractUsage(latestUsage, previousUsage);
      session.cumulativeUsage = latestUsage;

      if (cancelled) {
        // An aborted turn leaves Vibe's internal conversation state uncertain;
        // drop the warm session so the next turn starts cleanly.
        await this.dropSession(options.cwd, session);
      }

      const inputCount = options.messages.length;
      const inputFingerprint = fingerprintMessages(options.messages);

      return {
        sessionId: session.sessionId,
        stopReason,
        cancelled,
        reusedSession,
        text,
        thinking,
        usageDelta,
        cumulativeUsage: latestUsage,
        applied: { ...session.applied },
        commitSync: (assistantMessage) => {
          if (cancelled || this.sessions.get(options.cwd) !== session) return;
          session.sync = {
            systemPrompt,
            syncedInputCount: inputCount,
            syncedInputFingerprint: inputFingerprint,
            syncedAssistantFingerprint: fingerprintMessages([assistantMessage]),
          };
        },
      };
    } catch (error) {
      await this.dropSession(options.cwd, session);
      throw explainTurnError(error, session.authMethodCount);
    } finally {
      session.active = undefined;
    }
  }

  private async createSession(options: VibeProviderTurnOptions): Promise<WarmSession> {
    let sessionRef: WarmSession | undefined;
    let authMethodCount = 0;

    const client = new AcpClient({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      abortGraceMs: options.abortGraceMs,
      onSessionUpdate: (sessionId, update) => {
        if (sessionRef && sessionId === sessionRef.sessionId) {
          sessionRef.active?.onUpdate(update);
        }
      },
      onPermissionRequest: async (request) => {
        if (!sessionRef?.active) return { outcome: "cancelled" };
        return sessionRef.active.onPermission(request);
      },
    });

    try {
      const init = await client.initialize(
        {
          name: options.clientName ?? options.env?.PI_VIBE_ACP_CLIENT_NAME ?? "pi",
          title: "Pi",
          version: options.clientVersion ?? "unknown",
        },
        { signal: options.signal },
      );
      authMethodCount = init.authMethods?.length ?? 0;
      const closeSupported = supportsSessionClose(init);

      const created = await client.newSession(options.cwd, { signal: options.signal });
      const configOptions = created.configOptions ?? [];
      const applied: WarmSession["applied"] = {};
      for (const id of ["mode", "model", "thinking"] as const) {
        const current = configOptions.find((option) => option.id === id)?.currentValue;
        if (typeof current === "string") applied[id] = current;
      }

      sessionRef = {
        client,
        sessionId: created.sessionId,
        cwd: options.cwd,
        closeSupported,
        authMethodCount,
        configOptions,
        modes: created.modes?.availableModes ?? [],
        initial: { model: applied.model, thinking: applied.thinking },
        applied,
      };
      return sessionRef;
    } catch (error) {
      await client.dispose().catch(() => undefined);
      if (error instanceof AcpAbortError) throw error;
      throw explainTurnError(error, authMethodCount);
    }
  }

  private async dropSession(cwd: string, session: WarmSession): Promise<void> {
    if (this.sessions.get(cwd) === session) {
      this.sessions.delete(cwd);
    }
    await disposeSession(session);
  }
}

async function disposeSession(session: WarmSession): Promise<void> {
  await restorePersistedSettings(session);
  if (session.closeSupported) {
    await session.client.closeSession(session.sessionId).catch(() => undefined);
  }
  await session.client.dispose().catch(() => undefined);
}

/**
 * Put back the model and thinking level Vibe had persisted before this session.
 *
 * ACP exposes no session-scoped model option: `session/set_config_option` on
 * `model` or `thinking` writes the user's `~/.vibe/config.toml`, which would
 * otherwise leave Pi's `/model` pick changing the default of the `vibe` CLI.
 * Only values this session changed are restored, and failures are swallowed so
 * teardown never fails because the agent refused a write.
 */
async function restorePersistedSettings(session: WarmSession): Promise<void> {
  const initial = session.initial;
  if (!initial) return;
  for (const id of ["model", "thinking"] as const) {
    const original = initial[id];
    if (!original || original === session.applied[id]) continue;
    await session.client
      .setConfigOption(session.sessionId, id, original, { timeoutMs: 5_000 })
      .catch(() => undefined);
  }
}

function canContinueSession(
  session: WarmSession,
  systemPrompt: string,
  messages: readonly Message[],
): boolean {
  const sync = session.sync;
  if (!sync) return false;
  if (sync.systemPrompt !== systemPrompt) return false;
  // Next turn must contain: previous inputs + previous assistant reply + >=1 new message.
  if (messages.length <= sync.syncedInputCount + 1) return false;

  const previousAssistant = messages[sync.syncedInputCount];
  if (!previousAssistant || previousAssistant.role !== "assistant") return false;

  const prefixFingerprint = fingerprintMessages(messages.slice(0, sync.syncedInputCount));
  if (prefixFingerprint !== sync.syncedInputFingerprint) return false;

  const assistantFingerprint = fingerprintMessages([previousAssistant]);
  return assistantFingerprint === sync.syncedAssistantFingerprint;
}

/**
 * Compute per-turn token usage from Vibe's session-cumulative usage counters.
 */
export function subtractUsage(
  current: AcpUsage | undefined,
  previous: AcpUsage | undefined,
): AcpUsage | undefined {
  if (!current) return undefined;
  if (!previous) return { ...current };

  const inputTokens = Math.max(0, current.inputTokens - previous.inputTokens);
  const outputTokens = Math.max(0, current.outputTokens - previous.outputTokens);
  const cachedReadTokens = current.cachedReadTokens !== undefined
    ? Math.max(0, current.cachedReadTokens - (previous.cachedReadTokens ?? 0))
    : undefined;
  const totalTokens = Math.max(
    0,
    current.totalTokens - previous.totalTokens,
    inputTokens + outputTokens,
  );
  if (!totalTokens && !inputTokens && !outputTokens) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
  };
}

/** Deterministic fingerprint of normalized conversation messages for warm-session reuse. */
export function fingerprintMessages(messages: readonly Message[]): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(message.role);
    hash.update("\0");
    hash.update(extractMessageText(message));
    hash.update("\0\n");
  }
  return hash.digest("hex");
}

/** Render a full cold-start prompt from Pi's system prompt and conversation transcript. */
export function renderColdPrompt(
  systemPrompt: string | undefined,
  messages: readonly Message[],
): string {
  const conversation = messages.filter((message) => message.role !== "system");
  const sections: string[] = [];

  const trimmedSystem = systemPrompt?.trim();
  if (trimmedSystem) {
    sections.push(`<system_instructions>\n${trimmedSystem}\n</system_instructions>`);
  }

  if (conversation.length === 1 && conversation[0].role === "user") {
    sections.push(extractMessageText(conversation[0]));
    return sections.join("\n\n");
  }

  if (conversation.length > 0) {
    const historyLines = conversation.map((message) => {
      const label = message.role === "user"
        ? "User"
        : message.role === "assistant"
          ? "Assistant"
          : `Tool (${message.toolName})`;
      return `${label}:\n${extractMessageText(message)}`;
    });
    sections.push(`<conversation>\n${historyLines.join("\n\n")}\n</conversation>`);
  }

  return sections.join("\n\n") || "Continue.";
}

/** Render only the new messages appended since the last synced turn. */
export function renderDeltaPrompt(messages: readonly Message[]): string {
  const conversation = messages.filter((message) => message.role !== "system");
  if (conversation.length === 1 && conversation[0].role === "user") {
    return extractMessageText(conversation[0]) || "Continue.";
  }

  const lines = conversation.map((message) => {
    const label = message.role === "user"
      ? "User"
      : message.role === "assistant"
        ? "Assistant"
        : `Tool (${message.toolName})`;
    return `${label}:\n${extractMessageText(message)}`;
  });
  return lines.join("\n\n") || "Continue.";
}

function extractMessageText(message: Message): string {
  if (message.role === "system") {
    return typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
  }
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((block) => (block.type === "text" ? block.text : "[image attached]"))
      .filter(Boolean)
      .join("\n");
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text) parts.push(block.text);
      else if (block.type === "toolCall") {
        parts.push(`[tool call: ${block.name}(${JSON.stringify(block.arguments)})]`);
      }
    }
    return parts.join("\n");
  }
  // toolResult
  return message.content
    .map((block) => (block.type === "text" ? block.text : "[image output]"))
    .filter(Boolean)
    .join("\n");
}
