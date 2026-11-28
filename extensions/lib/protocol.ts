/**
 * Minimal Agent Client Protocol (ACP) surface used by this extension.
 *
 * Hand-written rather than imported: ACP is a small, versioned JSON-RPC schema,
 * and pinning the pieces we speak keeps the extension free of a runtime
 * dependency that Pi would have to install alongside it.
 *
 * Method names and payload shapes follow schema-v1.16.0 (protocolVersion 1),
 * which is what `vibe-acp` 3.1.x advertises (verified against 3.1.5).
 */

export const PROTOCOL_VERSION = 1;

export const AGENT_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  newSession: "session/new",
  loadSession: "session/load",
  setSessionMode: "session/set_mode",
  setConfigOption: "session/set_config_option",
  prompt: "session/prompt",
  cancel: "session/cancel",
  closeSession: "session/close",
} as const;

export const CLIENT_METHODS = {
  requestPermission: "session/request_permission",
  sessionUpdate: "session/update",
  /**
   * Client tools. An agent calls these only when the client advertises the
   * matching capability at `initialize`; otherwise the agent uses its own.
   */
  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",
  terminalRelease: "terminal/release",
} as const;

/** Which client tools this client can execute. Omitted parts are not advertised. */
export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AcpReadTextFileParams {
  sessionId: string;
  path: string;
  /** 1-indexed first line, as `read` describes it. */
  line?: number | null;
  limit?: number | null;
}

export interface AcpWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface AcpTerminalEnv {
  name: string;
  value: string;
}

export interface AcpTerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[] | null;
  env?: AcpTerminalEnv[] | null;
  cwd?: string | null;
  outputByteLimit?: number | null;
  toolCallId?: string | null;
}

export interface AcpTerminalRef {
  sessionId: string;
  terminalId: string;
}

export interface AcpReadTextFileResult {
  content: string;
}

export interface AcpTerminalCreateResult {
  terminalId: string;
}

export interface AcpTerminalWaitResult {
  exitCode?: number | null;
  signal?: string | null;
}

export interface AcpTerminalOutputResult {
  output: string;
  truncated?: boolean;
}

export type JsonRpcId = number | string;

export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
}

export interface AcpImplementation {
  name: string;
  title?: string;
  version: string;
}

export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: AcpImplementation;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: AcpAuthMethod[];
}

export interface AcpConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface AcpConfigOption {
  id: string;
  name?: string;
  type?: "select" | "boolean";
  category?: string | null;
  currentValue?: string | boolean | null;
  options?: AcpConfigSelectOption[];
}

export interface AcpSessionMode {
  id: string;
  name?: string;
  description?: string | null;
}

export interface AcpSessionNewResult {
  sessionId: string;
  modes?: {
    currentModeId?: string;
    availableModes?: AcpSessionMode[];
  } | null;
  configOptions?: AcpConfigOption[] | null;
}

/** What one permission option would grant, as Vibe describes it. */
export interface AcpPermissionRequirement {
  scope?: string;
  invocation_pattern?: string;
  session_pattern?: string;
  label?: string;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
  /** Underscored because that is the wire name; ACP reserves `_meta`. */
  _meta?: { required_permissions?: AcpPermissionRequirement[] } | null;
}

export interface AcpToolCallRef {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: AcpToolCallRef;
  options?: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** `session/update` payloads. `sessionUpdate` is the discriminator. */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string } | null;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string } | null;
  fieldMeta?: Record<string, unknown> | null;
}

export interface AcpPromptResult {
  stopReason: string;
  usage?: AcpUsage | null;
}

export interface AcpUsageUpdateMeta {
  steps?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  lastTurnTotalTokens?: number;
}

export function readUsageMeta(update: AcpSessionUpdate): AcpUsageUpdateMeta | undefined {
  const raw = update.fieldMeta ?? (update as { _meta?: Record<string, unknown> })._meta;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as AcpUsageUpdateMeta;
}

/** `session/close` exists in v1 only when the agent advertises it. */
export function supportsSessionClose(init: AcpInitializeResult): boolean {
  const sessionCapabilities = init.agentCapabilities?.sessionCapabilities;
  if (!sessionCapabilities || typeof sessionCapabilities !== "object") return false;
  const close = (sessionCapabilities as Record<string, unknown>).close;
  return typeof close === "object" && close !== null;
}
