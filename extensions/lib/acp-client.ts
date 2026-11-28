import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  type AcpClientCapabilities,
  type AcpConfigOption,
  type AcpImplementation,
  type AcpInitializeResult,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpPromptResult,
  type AcpSessionNewResult,
  type AcpSessionUpdate,
  type JsonRpcId,
} from "./protocol.js";

/** A JSON-RPC error returned by the agent, or a transport failure. */
export class AcpError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

export class AcpTimeoutError extends AcpError {
  constructor(method: string, timeoutMs: number) {
    super(`${method} did not answer within ${formatTimeout(timeoutMs)}`);
    this.name = "AcpTimeoutError";
  }
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 1_000) return `${timeoutMs}ms`;
  return `${Math.round(timeoutMs / 1_000)}s`;
}

export class AcpAbortError extends AcpError {
  constructor(method: string) {
    super(`${method} cancelled`);
    this.name = "AcpAbortError";
  }
}

/** A frame larger than this is a bug or a runaway agent, not real traffic. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_ABORT_GRACE_MS = 5_000;
const TERMINATE_GRACE_MS = 2_500;

/** Command to spawn. A blank override means "not set", not "spawn nothing". */
export function resolveCommand(command?: string): string {
  return command?.trim() || "vibe-acp";
}

export type PermissionHandler = (
  request: AcpPermissionRequest,
) => AcpPermissionOutcome | Promise<AcpPermissionOutcome>;

/**
 * A client-tool request the handler chose to answer later.
 *
 * ACP lets a response arrive after the request, so an agent waiting on it just
 * keeps waiting. That is what makes delegation possible: the agent's file or
 * shell work can be turned into a Pi tool call, and the answer only written once
 * Pi has actually run it. Settling twice is a no-op, and settling after the
 * connection closed is dropped, so a racing teardown cannot corrupt the stream.
 */
export interface DeferredClientRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  settle(result: unknown): void;
  fail(message: string, code?: number): void;
}

/** What `onClientTool` returns: an answer now, or ownership taken for later. */
export type ClientToolOutcome =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | "deferred"
  | undefined;

export type ClientToolHandler = (request: {
  method: string;
  params: unknown;
  deferred: DeferredClientRequest;
}) => ClientToolOutcome | Promise<ClientToolOutcome>;

export interface AcpClientOptions {
  /** Binary to run. Defaults to `vibe-acp`. */
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout when a caller does not pass one. 0 disables. */
  requestTimeoutMs?: number;
  /** How long an aborted request waits for the agent to acknowledge the cancel. */
  abortGraceMs?: number;
  onSessionUpdate?: (sessionId: string, update: AcpSessionUpdate) => void;
  onPermissionRequest?: PermissionHandler;
  /**
   * Client tools to advertise. Omit to advertise none, which makes the agent do
   * its own file and shell work with its own tools.
   */
  capabilities?: AcpClientCapabilities;
  /** Handles the client-tool requests made possible by `capabilities`. */
  onClientTool?: ClientToolHandler;
  onStderr?: (chunk: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  abortGraceTimer?: NodeJS.Timeout;
  cleanup?: () => void;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Notification sent to the agent when `signal` aborts (e.g. session/cancel). */
  cancelMethod?: string;
  cancelParams?: Record<string, unknown>;
}

/**
 * Newline-delimited JSON-RPC 2.0 client for an ACP agent on stdio.
 *
 * One instance owns one agent process. Every request settles exactly once:
 * on response, on timeout, on abort (after a grace window), on agent exit, or
 * on dispose. Nothing here retries; callers decide what a failure means.
 */
export class AcpClient {
  private readonly options: Required<
    Pick<AcpClientOptions, "command" | "args" | "cwd" | "requestTimeoutMs" | "abortGraceMs">
  > &
    Omit<AcpClientOptions, "command" | "args" | "cwd" | "requestTimeoutMs" | "abortGraceMs">;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  /**
   * Client-tool requests handed to `onClientTool` as deferred. Tracked so a
   * second settle is a no-op and teardown can fail them instead of leaving an
   * agent waiting on an answer that will never come.
   */
  private readonly deferred = new Map<JsonRpcId, { method: string }>();
  private readonly exitPromise: Promise<void>;
  private buffer = "";
  private stderrTail = "";
  private nextId = 1;
  private settled = false;
  private disposed = false;

  constructor(options: AcpClientOptions) {
    this.options = {
      ...options,
      command: resolveCommand(options.command),
      args: options.args ?? [],
      cwd: options.cwd,
      // Explicit `undefined` must not erase the defaults a spread would overwrite.
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      abortGraceMs: options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS,
    };

    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = keepTail(this.stderrTail + chunk, STDERR_TAIL_BYTES);
      this.options.onStderr?.(chunk);
    });

    this.exitPromise = new Promise<void>((resolve) => {
      this.child.once("error", (error: Error) => {
        this.settleAll(
          new AcpError(`could not start "${this.options.command}": ${error.message}`),
        );
        resolve();
      });
      this.child.once("exit", (code, signal) => {
        this.settleAll(
          new AcpError(
            `agent exited before answering (code ${code ?? "null"}, signal ${signal ?? "none"})` +
              this.describeStderr(),
          ),
        );
        resolve();
      });
    });
  }

  /** Errors from the last stderr burst, appended to transport failures. */
  private describeStderr(): string {
    const tail = this.stderrTail.trim();
    return tail ? `: ${keepTail(tail, 600)}` : "";
  }

  async initialize(
    clientInfo: AcpImplementation,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>(
      AGENT_METHODS.initialize,
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: this.describeCapabilities(),
        clientInfo,
      },
      options,
    );
  }

  /**
   * The `clientCapabilities` block, holding only what this client can serve.
   *
   * Agents gate delegation on these flags, so advertising a capability without
   * a handler would hand the agent work this client cannot do. Keys are omitted
   * rather than sent as `false` when nothing is advertised: an empty object is
   * what "uses its own tools" looks like on the wire.
   */
  private describeCapabilities(): Record<string, unknown> {
    const capabilities = this.options.capabilities;
    if (!capabilities) return {};
    const fs: Record<string, boolean> = {};
    if (capabilities.fs?.readTextFile) fs.readTextFile = true;
    if (capabilities.fs?.writeTextFile) fs.writeTextFile = true;
    const described: Record<string, unknown> = {};
    if (Object.keys(fs).length > 0) described.fs = fs;
    if (capabilities.terminal) described.terminal = true;
    return described;
  }

  async newSession(
    cwd: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AcpSessionNewResult> {
    return this.request<AcpSessionNewResult>(
      AGENT_METHODS.newSession,
      { cwd, mcpServers: [] },
      options,
    );
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AcpConfigOption[] | undefined> {
    const result = await this.request<{ configOptions?: AcpConfigOption[] }>(
      AGENT_METHODS.setConfigOption,
      // `type` describes the value's shape, not the option kind: ACP defines
      // "boolean" and "id" (id is the default for string values), and agents must
      // reject anything else with -32602.
      { sessionId, configId, value, type: typeof value === "boolean" ? "boolean" : "id" },
      options,
    );
    return result?.configOptions;
  }

  /** For agents that expose modes only through the dedicated session method. */
  async setSessionMode(
    sessionId: string,
    modeId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    await this.request<unknown>(AGENT_METHODS.setSessionMode, { sessionId, modeId }, options);
  }

  /**
   * Send one prompt and wait for the turn to finish. An abort sends
   * `session/cancel` and gives the agent `abortGraceMs` to stop cleanly; if it
   * answers with `stopReason: cancelled` the caller sees a normal result.
   */
  async prompt(
    sessionId: string,
    text: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AcpPromptResult> {
    return this.request<AcpPromptResult>(
      AGENT_METHODS.prompt,
      { sessionId, prompt: [{ type: "text", text }] },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        cancelMethod: AGENT_METHODS.cancel,
        cancelParams: { sessionId },
      },
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    // Best effort and short: teardown must not wait on an agent that is already
    // wedged, since dispose() can kill it.
    await this.request<unknown>(AGENT_METHODS.closeSession, { sessionId }, { timeoutMs: 5_000 });
  }

  /** Current stderr tail, for diagnostics after a failure. */
  getStderr(): string {
    return this.stderrTail;
  }

  async request<T>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.settled) {
      throw new AcpError(`cannot send ${method}: connection is closed`);
    }
    if (options.signal?.aborted) {
      throw new AcpAbortError(method);
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      const settle = (fn: () => void) => {
        this.clearPending(id, pending);
        fn();
      };

      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          settle(() => reject(new AcpTimeoutError(method, timeoutMs)));
        }, timeoutMs);
        pending.timer.unref?.();
      }

      if (options.signal) {
        const onAbort = () => {
          // Without a cancel notification the agent cannot acknowledge anything,
          // so a grace window would only delay the caller.
          if (!options.cancelMethod) {
            settle(() => reject(new AcpAbortError(method)));
            return;
          }
          // After cancellation starts, only the grace window should time out
          // this request; the original deadline can no longer win the race.
          if (pending.timer) clearTimeout(pending.timer);
          pending.timer = undefined;
          try {
            this.send({
              jsonrpc: "2.0",
              method: options.cancelMethod,
              params: options.cancelParams,
            });
          } catch (error) {
            settle(() => reject(error as Error));
            return;
          }
          pending.abortGraceTimer = setTimeout(() => {
            settle(() => reject(new AcpAbortError(method)));
          }, this.options.abortGraceMs);
          pending.abortGraceTimer.unref?.();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, pending);
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        settle(() => reject(error as Error));
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.exitPromise;
      return;
    }
    this.disposed = true;

    try {
      this.child.stdin.end();
    } catch {
      // The pipe may already be gone; the exit path below still applies.
    }

    if (!(await this.waitForExit(TERMINATE_GRACE_MS))) {
      this.child.kill("SIGTERM");
      if (!(await this.waitForExit(TERMINATE_GRACE_MS))) {
        this.child.kill("SIGKILL");
        await this.waitForExit(TERMINATE_GRACE_MS);
      }
    }

    this.settleAll(new AcpError("connection disposed"));
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.exitPromise.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.settled || this.disposed) {
      throw new AcpError(`cannot send ${String(message.method ?? "response")}: connection is closed`);
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw new AcpError(`write to agent failed: ${(error as Error).message}`);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }

    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.buffer = "";
      this.settleAll(new AcpError("agent sent an oversized frame; dropping the connection"));
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Agents occasionally print diagnostics on stdout. Ignore unusable lines
      // rather than failing a turn over them.
      return;
    }
    if (!message || typeof message !== "object") return;

    const hasId = "id" in message && message.id !== null && message.id !== undefined;
    const method = typeof message.method === "string" ? message.method : undefined;

    if (method && hasId) {
      void this.onIncomingRequest(message.id as JsonRpcId, method, message.params);
      return;
    }
    if (method) {
      this.onNotification(method, message.params);
      return;
    }
    if (hasId) {
      this.onResponse(message.id as JsonRpcId, message);
    }
  }

  private onResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.clearPending(id, pending);

    const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (error) {
      pending.reject(
        new AcpError(error.message ?? `${pending.method} failed`, error.code, error.data),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== CLIENT_METHODS.sessionUpdate) return;
    const payload = params as { sessionId?: string; update?: AcpSessionUpdate } | undefined;
    if (!payload?.sessionId || !payload.update) return;
    this.options.onSessionUpdate?.(payload.sessionId, payload.update);
  }

  private async onIncomingRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method === CLIENT_METHODS.requestPermission) {
      let outcome: AcpPermissionOutcome = { outcome: "cancelled" };
      try {
        const request = params as AcpPermissionRequest;
        outcome = (await this.options.onPermissionRequest?.(request)) ?? outcome;
      } catch {
        // A failing policy must deny, never hang the agent.
        outcome = { outcome: "cancelled" };
      }
      this.respond(id, { outcome });
      return;
    }

    if (isClientToolMethod(method)) {
      await this.onClientToolRequest(id, method, params);
      return;
    }

    // Elicitation and MCP were not advertised, so a well-behaved agent never
    // asks. Refusing keeps a misbehaving one from borrowing this client's
    // authority.
    this.respondError(id, -32601, `${method} is not supported by this client`);
  }

  private async onClientToolRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.options.onClientTool;
    if (!handler) {
      this.respondError(id, -32601, `${method} is not supported by this client`);
      return;
    }

    // Register before calling the handler: it may settle synchronously, and a
    // late settle after teardown must be a no-op rather than a write to a dead pipe.
    this.deferred.set(id, { method });
    const request: DeferredClientRequest = {
      id,
      method,
      settle: (result) => {
        if (!this.takeDeferred(id)) return;
        this.respond(id, result);
      },
      fail: (message, code = -32603) => {
        if (!this.takeDeferred(id)) return;
        this.respondError(id, code, message);
      },
    };

    let outcome: ClientToolOutcome;
    try {
      outcome = await handler({ method, params, deferred: request });
    } catch (error) {
      // A throwing handler is a bug, not an instruction to hang the agent.
      request.fail(error instanceof Error ? error.message : String(error));
      return;
    }

    // Ownership taken for later: the handler answers through `deferred`.
    if (outcome === "deferred") return;
    if (!this.takeDeferred(id)) {
      // Already settled through `deferred`, so a return value is redundant.
      return;
    }
    if (!outcome) {
      this.respondError(id, -32601, `${method} is not supported by this client`);
      return;
    }
    if ("error" in outcome) {
      this.respondError(id, outcome.error.code, outcome.error.message);
      return;
    }
    this.respond(id, outcome.result);
  }

  /** Removes a deferred request, reporting whether the caller now owns it. */
  private takeDeferred(id: JsonRpcId): boolean {
    return this.deferred.delete(id);
  }

  private respond(id: JsonRpcId, result: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", id, result });
    } catch {
      // The connection is already gone; the pending request handles the error.
    }
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    try {
      this.send({ jsonrpc: "2.0", id, error: { code, message } });
    } catch {
      // Same as respond().
    }
  }

  private clearPending(id: JsonRpcId, pending: PendingRequest): void {
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abortGraceTimer) clearTimeout(pending.abortGraceTimer);
    pending.cleanup?.();
    pending.timer = undefined;
    pending.abortGraceTimer = undefined;
    pending.cleanup = undefined;
  }

  private settleAll(error: Error): void {
    this.settled = true;
    const entries = [...this.pending.entries()];
    for (const [id, pending] of entries) {
      this.clearPending(id, pending);
      pending.reject(error);
    }
    // Drop deferred requests: the agent is gone, so nothing can consume an
    // answer, and a late settle must not write to a closed pipe.
    this.deferred.clear();
  }
}

function isClientToolMethod(method: string): boolean {
  return (
    method === CLIENT_METHODS.fsReadTextFile ||
    method === CLIENT_METHODS.fsWriteTextFile ||
    method === CLIENT_METHODS.terminalCreate ||
    method === CLIENT_METHODS.terminalOutput ||
    method === CLIENT_METHODS.terminalWaitForExit ||
    method === CLIENT_METHODS.terminalKill ||
    method === CLIENT_METHODS.terminalRelease
  );
}

function keepTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}
