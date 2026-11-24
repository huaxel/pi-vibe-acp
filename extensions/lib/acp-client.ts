import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
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

export type PermissionHandler = (
  request: AcpPermissionRequest,
) => AcpPermissionOutcome | Promise<AcpPermissionOutcome>;

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
  private readonly exitPromise: Promise<void>;
  private buffer = "";
  private stderrTail = "";
  private nextId = 1;
  private settled = false;
  private disposed = false;

  constructor(options: AcpClientOptions) {
    this.options = {
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      abortGraceMs: DEFAULT_ABORT_GRACE_MS,
      ...options,
      command: options.command ?? "vibe-acp",
      args: options.args ?? [],
      cwd: options.cwd,
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

  async initialize(clientInfo: AcpImplementation): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      // No filesystem, terminal, or MCP capabilities: the agent uses its own
      // tools and must never route work through this client.
      clientCapabilities: {},
      clientInfo,
    });
  }

  async newSession(cwd: string): Promise<AcpSessionNewResult> {
    return this.request<AcpSessionNewResult>(AGENT_METHODS.newSession, {
      cwd,
      mcpServers: [],
    });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<AcpConfigOption[] | undefined> {
    const result = await this.request<{ configOptions?: AcpConfigOption[] }>(
      AGENT_METHODS.setConfigOption,
      { sessionId, configId, value, type: typeof value === "boolean" ? "boolean" : "select" },
    );
    return result?.configOptions;
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
          if (options.cancelMethod) {
            this.send({
              jsonrpc: "2.0",
              method: options.cancelMethod,
              params: options.cancelParams,
            });
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

    // No filesystem, terminal, elicitation, or MCP capabilities were advertised,
    // so a well-behaved agent never asks. Refusing keeps a misbehaving one from
    // borrowing this client's authority.
    this.respondError(id, -32601, `${method} is not supported by this client`);
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
  }
}

function keepTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}
