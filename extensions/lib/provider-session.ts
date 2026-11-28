import { createHash } from "node:crypto";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { AcpAbortError, AcpClient } from "./acp-client.js";
import {
  planClientRequest,
  settleClientResult,
  TerminalRegistry,
  type ParkedCall,
} from "./client-bridge.js";
import {
  CLIENT_METHODS,
  readUsageMeta,
  supportsSessionClose,
  type AcpClientCapabilities,
  type AcpConfigOption,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpPromptResult,
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
  /**
   * Client tools to delegate to Pi. Derived from the Pi tools actually present,
   * so an agent never hands us work this session cannot execute.
   */
  capabilities?: AcpClientCapabilities;
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
  /**
   * Actions this session asked Pi to perform. When present the turn yields no
   * answer: Pi runs them and its tool results resume the same Vibe turn.
   */
  parks?: ParkedCall[];
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
  /** Fingerprint of the client tools this session was created with. */
  bridgeKey: string;
  terminals: TerminalRegistry;
  /** Shadow calls Pi has been asked to run and has not reported on yet. */
  parks: Map<string, ParkedCall>;
  /** Client-tool requests that arrived and still need a Pi tool call. */
  parkQueue: ParkedCall[];
  /** Resolvers waiting for the next park, so a turn can stop waiting on the agent. */
  parkWaiters: Array<() => void>;
  /**
   * The `session/prompt` request currently in flight, if any. It outlives a Pi
   * turn: a park ends that turn while Vibe is still working, and the tool result
   * arrives on a later one.
   */
  pending?: { abort: AbortController; settled: Promise<SettledPrompt> };
}

type SettledPrompt =
  | { ok: true; result: AcpPromptResult }
  | { ok: false; error: unknown };

/** How long a turn waits for sibling parks before handing them to Pi together. */
const PARK_COLLECT_MS = 120;

const DEFAULT_PROVIDER_TIMEOUT_MS = 900_000;
/**
 * Deadline for a turn that delegates actions to Pi. A write or command may wait
 * on a human approval, so the ordinary turn deadline would fire mid-thought.
 */
const BRIDGED_PROMPT_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

/** How a turn ended: an answer, or actions handed to Pi. */
type TurnBoundary =
  | { kind: "done"; stopReason: string; cancelled: boolean; usage?: AcpUsage }
  | { kind: "parked"; parks: ParkedCall[] };

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
    const bridgeKey = describeBridge(options.capabilities);

    let session: WarmSession | undefined;
    let promptText: string | undefined;
    let reusedSession = false;
    let deliveries: Array<{ call: ParkedCall; result: ToolResultMessage }> = [];

    // Mid-turn resume: Pi ran the action Vibe is waiting on, so answer the parked
    // request and pick the same Vibe turn back up instead of starting a new one.
    const waiting = this.sessions.get(options.cwd);
    if (waiting?.pending) {
      deliveries = matchDeliveries(options.messages, waiting.parks);
      // A resumed turn still runs under the capabilities negotiated at
      // `initialize`. If Pi's toolset changed since the park, the agent could
      // hand back an action this turn can no longer execute, so rebuild instead.
      if (deliveries.length > 0 && waiting.bridgeKey === bridgeKey) {
        session = waiting;
        reusedSession = true;
        // The same request is still in flight; there is nothing new to prompt.
        promptText = undefined;
      } else {
        // Pi's transcript moved on without delivering (abort, retry, or a new
        // user turn). Cancel the suspended turn: leaving it running would wedge
        // the workspace behind a prompt nobody is left to answer.
        await this.abandonPending(options.cwd, waiting);
      }
    }

    if (!session) {
      const current = this.sessions.get(options.cwd);
      const canReuse =
        current !== undefined &&
        // A different tool set means a different delegation contract, which can
        // only be negotiated at `initialize`.
        current.bridgeKey === bridgeKey &&
        canContinueSession(current, systemPrompt, options.messages);

      if (canReuse && current.sync) {
        session = current;
        reusedSession = true;
        const deltaMessages = options.messages.slice(current.sync.syncedInputCount + 1);
        promptText = renderDeltaPrompt(deltaMessages);
      } else {
        if (current) {
          this.sessions.delete(options.cwd);
          await disposeSession(current);
        }
        session = await this.createSession(options, bridgeKey);
        this.sessions.set(options.cwd, session);
        promptText = renderColdPrompt(systemPrompt, options.messages);
      }
    }

    const previousUsage = session.cumulativeUsage;
    let latestUsage = previousUsage;
    let text = "";
    let thinking = "";
    const toolTitles = new Map<string, string>();
    // Client-tool requests are separate from Vibe's own tool-permission flow.
    // Keep the configured policy for Vibe-native actions even when this session
    // advertises Pi tools: an agent may ignore those capabilities and execute its
    // own tools instead (as vibe-acp 3.1.5 does).

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
          options.permission === "approve" ? undefined : options.confirm,
          (id) => toolTitles.get(id),
          options.signal,
        );
      },
    };

    try {
      if (promptText !== undefined) {
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
      }

      // Answer Vibe's parked requests from what Pi actually did before resuming,
      // so it continues past them instead of repeating the action.
      for (const { call, result } of deliveries) {
        session.parks.delete(call.id);
        settleClientResult({ call, result, terminals: session.terminals });
      }

      if (promptText !== undefined) {
        this.startPrompt(session, promptText, options);
      }
      const boundary = await this.awaitBoundary(session, options);
      if (boundary.kind === "done") {
        // The request is finished, so the next turn is a new prompt rather than
        // a resume of this one.
        session.pending = undefined;
      }

      if (boundary.kind === "done" && boundary.usage) {
        latestUsage = mergeUsage(latestUsage, boundary.usage);
      }
      const usageDelta = subtractUsage(latestUsage, previousUsage);
      session.cumulativeUsage = latestUsage;

      if (boundary.kind === "parked") {
        // This Pi turn ends here. The next one delivers the results and resumes
        // the same Vibe turn, so nothing is marked synced yet.
        return {
          sessionId: session.sessionId,
          stopReason: "tool_use",
          cancelled: false,
          reusedSession,
          text,
          thinking,
          parks: boundary.parks,
          usageDelta,
          cumulativeUsage: latestUsage,
          applied: { ...session.applied },
          commitSync: () => undefined,
        };
      }

      const cancelled = boundary.cancelled;
      if (cancelled) {
        // An aborted turn leaves Vibe's internal conversation state uncertain;
        // drop the warm session so the next turn starts cleanly.
        await this.dropSession(options.cwd, session);
      }

      const inputCount = options.messages.length;
      const inputFingerprint = fingerprintMessages(options.messages);

      return {
        sessionId: session.sessionId,
        stopReason: boundary.stopReason,
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

  /**
   * Send the prompt for the turn in flight and remember it.
   *
   * The request is stored rather than awaited: a park ends the Pi turn while
   * Vibe is still working, and the answer is only written on a later turn. The
   * promise is flattened to a value so a rejection nobody is listening to yet
   * cannot surface as an unhandled rejection.
   */
  private startPrompt(
    session: WarmSession,
    promptText: string,
    options: VibeProviderTurnOptions,
  ): void {
    const abort = new AbortController();
    const bridging = session.bridgeKey !== "";
    // A delegated action is approved by a human, so the ordinary turn deadline
    // would expire mid-thought. Liveness is still bounded: an abort or a dropped
    // session kills the agent process.
    const timeoutMs =
      options.timeoutMs ?? (bridging ? BRIDGED_PROMPT_TIMEOUT_MS : DEFAULT_PROVIDER_TIMEOUT_MS);
    session.pending = {
      abort,
      settled: session.client
        .prompt(session.sessionId, promptText, { signal: abort.signal, timeoutMs })
        .then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
    };
  }

  /** Wait for this turn to either finish or hand an action to Pi. */
  private async awaitBoundary(
    session: WarmSession,
    options: VibeProviderTurnOptions,
  ): Promise<TurnBoundary> {
    const pending = session.pending;
    if (!pending) throw new Error("no prompt is in flight");

    // Requests that arrived while Pi was busy with the previous actions.
    if (session.parkQueue.length > 0) {
      return { kind: "parked", parks: this.drainParks(session) };
    }

    let waiter: (() => void) | undefined;
    // Forward this turn's abort to Vibe while it is the turn we are waiting on.
    // It is detached afterwards: ending at a park abandons this signal, and the
    // agent's work must not be cancelled by it.
    const onAbort = () => pending.abort.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const raced = await Promise.race([
        pending.settled.then((settled) => ({ kind: "settled" as const, settled })),
        new Promise<{ kind: "parked" }>((resolve) => {
          waiter = () => resolve({ kind: "parked" });
          session.parkWaiters.push(waiter);
        }),
      ]);

      if (raced.kind === "parked") {
        // Sibling calls from one model step arrive back to back; collect them
        // into a single set of Pi tool calls instead of several rounds.
        await delay(PARK_COLLECT_MS);
        return { kind: "parked", parks: this.drainParks(session) };
      }

      const { settled } = raced;
      if (!settled.ok) {
        if (settled.error instanceof AcpAbortError) {
          return { kind: "done", stopReason: "cancelled", cancelled: true };
        }
        throw settled.error;
      }
      const stopReason = settled.result.stopReason ?? "end_turn";
      return {
        kind: "done",
        stopReason,
        cancelled: stopReason === "cancelled",
        usage: settled.result.usage ?? undefined,
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (waiter) {
        const index = session.parkWaiters.indexOf(waiter);
        if (index !== -1) session.parkWaiters.splice(index, 1);
      }
    }
  }

  /** Move queued client-tool requests into the set Pi is about to run. */
  private drainParks(session: WarmSession): ParkedCall[] {
    const parks = session.parkQueue.splice(0, session.parkQueue.length);
    for (const park of parks) session.parks.set(park.id, park);
    return parks;
  }

  /**
   * Cancel a turn whose tool results never arrived, then drop the session.
   *
   * The rebuild below would dispose this session anyway: a parked turn never
   * commits its sync state, so it can never be reused. Cancelling first is what
   * guarantees the abandoned agent stops working before its replacement starts,
   * and that the requests it is waiting on are answered rather than dropped with
   * the process.
   */
  private async abandonPending(cwd: string, session: WarmSession): Promise<void> {
    const pending = session.pending;
    session.pending = undefined;
    pending?.abort.abort();
    for (const park of [...session.parks.values(), ...session.parkQueue]) {
      park.deferred.fail("Pi did not report a result for this action");
    }
    session.parks.clear();
    session.parkQueue.length = 0;
    await this.dropSession(cwd, session);
  }


  private async createSession(
    options: VibeProviderTurnOptions,
    bridgeKey: string,
  ): Promise<WarmSession> {
    let sessionRef: WarmSession | undefined;
    let authMethodCount = 0;
    const terminals = new TerminalRegistry();

    const client = new AcpClient({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      abortGraceMs: options.abortGraceMs,
      capabilities: options.capabilities,
      onSessionUpdate: (sessionId, update) => {
        if (sessionRef && sessionId === sessionRef.sessionId) {
          sessionRef.active?.onUpdate(update);
        }
      },
      onPermissionRequest: async (request) => {
        if (!sessionRef?.active) return { outcome: "cancelled" };
        return sessionRef.active.onPermission(request);
      },
      onClientTool: ({ method, params, deferred }) => {
        const session = sessionRef;
        const payload = (params ?? {}) as Record<string, unknown>;
        // Only serve the session we negotiated, and only the tools we advertised:
        // anything else would let the agent borrow authority Pi never granted.
        if (!session || payload.sessionId !== session.sessionId) {
          deferred.fail(`${method} does not belong to this session`);
          return "deferred";
        }
        if (!isClientMethodAdvertised(method, session.bridgeKey)) {
          deferred.fail(`${method} was not advertised by this client`);
          return "deferred";
        }

        const decision = planClientRequest({
          method,
          params: payload,
          deferred,
          terminals: session.terminals,
        });
        if (decision.kind === "immediate") {
          if (decision.error) {
            deferred.fail(decision.error);
          } else if (decision.result === undefined) {
            deferred.fail(`${method} is not supported by this client`);
          } else {
            deferred.settle(decision.result);
          }
          return "deferred";
        }

        // Park it: the turning point of this whole design. Vibe waits, this Pi
        // turn ends with a real tool call, and the result arrives on a later one.
        session.parkQueue.push(decision.call);
        for (const wake of session.parkWaiters.splice(0)) wake();
        return "deferred";
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
        bridgeKey,
        terminals,
        parks: new Map(),
        parkQueue: [],
        parkWaiters: [],
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
  // Stop a turn still in flight first: closing under it would leave the agent
  // reporting a cancel it never acknowledged.
  session.pending?.abort.abort();
  session.pending = undefined;
  session.terminals.clear();
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

/**
 * Fingerprint the delegation contract. Two turns with different client tools
 * need different sessions: capabilities are only negotiated at `initialize`.
 */
export function isClientMethodAdvertised(method: string, bridgeKey: string): boolean {
  const advertised = new Set(bridgeKey.split(","));
  if (method === CLIENT_METHODS.fsWriteTextFile) return advertised.has("write");
  if (
    method === CLIENT_METHODS.terminalCreate ||
    method === CLIENT_METHODS.terminalOutput ||
    method === CLIENT_METHODS.terminalWaitForExit ||
    method === CLIENT_METHODS.terminalKill ||
    method === CLIENT_METHODS.terminalRelease
  ) {
    return advertised.has("terminal");
  }
  return false;
}

export function describeBridge(capabilities: AcpClientCapabilities | undefined): string {
  if (!capabilities) return "";
  const parts: string[] = [];
  if (capabilities.fs?.writeTextFile) parts.push("write");
  if (capabilities.terminal) parts.push("terminal");
  return parts.join(",");
}

/**
 * Pair parked calls with the Pi tool results that answer them.
 *
 * Matched by shadow `toolCallId`, which is what Pi's transcript carries and the
 * only thing tying a later turn back to the request Vibe is still waiting on.
 */
export function matchDeliveries(
  messages: readonly Message[],
  parks: ReadonlyMap<string, ParkedCall>,
): Array<{ call: ParkedCall; result: ToolResultMessage }> {
  if (parks.size === 0) return [];
  const deliveries: Array<{ call: ParkedCall; result: ToolResultMessage }> = [];
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const call = parks.get(message.toolCallId);
    if (call) deliveries.push({ call, result: message });
  }
  return deliveries;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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
