#!/usr/bin/env node
/**
 * Minimal ACP agent used by the tests.
 *
 * Speaks newline-delimited JSON-RPC on stdio, behaves like a well-formed (and
 * occasionally badly-behaved) agent, and writes a JSON report on exit so tests
 * can assert what the client actually sent it.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const behavior = flag("--behavior") ?? "normal";
const reportPath = flag("--report");

const report = {
  behavior,
  methods: [],
  initialize: null,
  newSession: null,
  configOptions: [],
  modes: [],
  permissionOutcomes: [],
  cancelReceived: false,
  closeSession: false,
  unexpectedClientMethods: [],
};

const configOptions = () => [
  {
    id: "mode",
    name: "Session Mode",
    type: "select",
    currentValue: "accept-edits",
    options: [
      { value: "ask", name: "Ask" },
      { value: "accept-edits", name: "Accept edits" },
      { value: "auto-approve", name: "Auto approve" },
    ],
  },
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "fake-one",
    options: [
      { value: "fake-one", name: "Fake One" },
      { value: "fake-two", name: "Fake Two" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    type: "select",
    currentValue: "low",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

let options = configOptions();
let pendingPromptId = null;
let pendingPromptSession = null;
let permissionSequence = 0;
let pendingPermission = null;
let slowTimer = null;
const outboundRequests = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function update(sessionId, payload) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: payload },
  });
}

function requestPermission(sessionId, promptId) {
  const id = 900 + ++permissionSequence;
  pendingPermission = { id, promptId, sessionId };
  const once = { optionId: "allow_once", name: "Allow once", kind: "allow_once" };
  const always = { optionId: "allow_always", name: "Always allow", kind: "allow_always" };
  const permanent = { optionId: "allow_always_permanent", name: "Always allow", kind: "allow_always" };
  const reject = { optionId: "reject_once", name: "Reject", kind: "reject_once" };
  // Real agents are free to order these however they like; the client must not
  // read that order as a preference.
  const options =
    behavior === "ask-always"
      ? [always, once, reject]
      : behavior === "ask-always-only"
        ? [permanent, always, reject]
        : behavior === "ask-permanent-only"
          ? [permanent, reject]
          : [once, reject];
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      // Vibe 3.1.5 sends only a reference; the title arrives in session/update.
      toolCall: { toolCallId: behavior === "ask-unknown-tool" ? "unknown-tool" : "tool-1" },
      options,
    },
  });
}

function finishTurn(promptId, sessionId) {
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "world" },
  });
  if (behavior === "usage-partial") {
    // Counts but no total, and no usage on the response: the client must sum them.
    update(sessionId, {
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 900, completionTokens: 100, cachedTokens: 0 },
    });
    pendingPromptId = null;
    respond(promptId, { stopReason: "end_turn" });
    return;
  }
  update(sessionId, {
    sessionUpdate: "usage_update",
    used: 1200,
    size: 128000,
    _meta: { promptTokens: 1200, completionTokens: 34, cachedTokens: 0, totalTokens: 1234 },
  });
  pendingPromptId = null;
  respond(promptId, {
    stopReason: "end_turn",
    usage: { inputTokens: 1200, outputTokens: 34, totalTokens: 1234 },
  });
}

function handlePrompt(message) {
  const sessionId = message.params?.sessionId ?? "fake-session";

  if (behavior === "exit-mid") {
    process.stderr.write("fake agent exploded before answering\n");
    process.exit(3);
  }

  if (behavior === "hang" || behavior === "ignore-cancel") {
    pendingPromptId = message.id;
    pendingPromptSession = sessionId;
    return;
  }

  if (behavior === "garbage") {
    process.stdout.write("this is not json\n");
    send({ jsonrpc: "2.0", id: 4242, result: { ignored: true } });
  }

  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hello " },
  });
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "bash: ls -la",
    kind: "execute",
    status: "pending",
  });

  if (behavior === "slow") {
    pendingPromptId = message.id;
    pendingPromptSession = sessionId;
    slowTimer = setTimeout(() => finishTurn(message.id, sessionId), 30_000);
    return;
  }

  pendingPromptId = message.id;
  pendingPromptSession = sessionId;
  requestPermission(sessionId, message.id);
}

function handlePromptResponse(message) {
  const outcome = message.result?.outcome ?? null;
  const decision = outcome
    ? outcome.outcome === "selected"
      ? `selected:${outcome.optionId}`
      : "cancelled"
    : "cancelled";
  report.permissionOutcomes.push(decision);

  if (!pendingPermission) return;
  const { promptId, sessionId } = pendingPermission;
  pendingPermission = null;
  finishTurn(promptId, sessionId);
}

function handle(message) {
  report.methods.push(message.method ?? `response:${message.id}`);

  if (message.id !== undefined && message.method === undefined) {
    if (outboundRequests.has(message.id)) {
      const method = outboundRequests.get(message.id);
      outboundRequests.delete(message.id);
      report.unexpectedClientMethods.push({ method, error: message.error ?? null });
      // Observable marker so a test can wait for the refusal without sleeping.
      if (reportPath) {
        try {
          writeFileSync(`${reportPath}.refused`, JSON.stringify({ method, error: message.error }));
        } catch {
          // Ignore: the report at exit still carries the record.
        }
      }
      maybeExit();
      return;
    }
    handlePromptResponse(message);
    return;
  }

  switch (message.method) {
    case "initialize":
      report.initialize = message.params;
      if (behavior === "hang-init") return;
      respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "@mistralai/mistral-vibe", title: "Mistral Vibe", version: "3.1.4-fake" },
        agentCapabilities: {
          loadSession: true,
          // "no-close" models an agent that never advertised session/close.
          ...(behavior === "no-close" ? {} : { sessionCapabilities: { close: {} } }),
        },
        authMethods: [{ id: "browser-auth", name: "Sign in" }],
      });
      if (behavior === "ask-fs") {
        outboundRequests.set(700, "fs/read_text_file");
        send({
          jsonrpc: "2.0",
          id: 700,
          method: "fs/read_text_file",
          params: { sessionId: "fake-session", path: "/etc/shadow" },
        });
      }
      return;

    case "session/new":
      report.newSession = message.params;
      respond(message.id, {
        sessionId: "fake-session",
        modes: {
          currentModeId: "accept-edits",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "accept-edits", name: "Accept edits" },
            { id: "auto-approve", name: "Auto approve" },
          ],
        },
        // "modes-only" models an agent that never turned mode into a config
        // option; ACP keeps the dedicated session/set_mode for exactly this.
        configOptions: behavior === "modes-only" ? options.filter((o) => o.id !== "mode") : options,
      });
      return;

    case "session/set_mode": {
      const { modeId } = message.params ?? {};
      report.modes.push(modeId);
      respond(message.id, {});
      return;
    }

    case "session/set_config_option": {
      const { configId, value, type } = message.params ?? {};
      // ACP: `type` describes the value's shape. "boolean" for booleans, "id"
      // for id values, and an unsupported type must be rejected with -32602.
      const expectedType = typeof value === "boolean" ? "boolean" : "id";
      if (type !== undefined && type !== expectedType) {
        respondError(message.id, -32602, `unsupported value type ${JSON.stringify(type)}`);
        return;
      }
      const option = options.find((candidate) => candidate.id === configId);
      const allowed = (option?.options ?? []).map((choice) => choice.value);
      if (!option || !allowed.includes(value)) {
        respondError(message.id, -32602, `unsupported ${configId}=${value}`);
        return;
      }
      report.configOptions.push({ configId, value });
      if (behavior === "config-stale") {
        // The agent keeps its own value and reports it back; the client must not
        // claim the requested value was applied.
        respond(message.id, { configOptions: options });
        return;
      }
      options = options.map((candidate) =>
        candidate.id === configId ? { ...candidate, currentValue: value } : candidate,
      );
      respond(message.id, { configOptions: options });
      return;
    }

    case "session/prompt":
      handlePrompt(message);
      return;

    case "session/cancel":
      report.cancelReceived = true;
      // A wedged agent that ignores cancellation; the client must not hang on it.
      if (behavior === "ignore-cancel") return;
      if (slowTimer) {
        clearTimeout(slowTimer);
        slowTimer = null;
      }
      if (pendingPromptId !== null) {
        const id = pendingPromptId;
        const sessionId = pendingPromptSession;
        pendingPromptId = null;
        respond(id, {
          stopReason: "cancelled",
          usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
        });
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
      }
      return;

    case "session/close":
      if (behavior === "no-close") {
        respondError(message.id, -32601, "session/close unsupported");
        return;
      }
      report.closeSession = true;
      respond(message.id, {});
      return;

    default:
      if (message.id !== undefined) {
        respondError(message.id, -32601, `unsupported method ${message.method}`);
      }
  }

  maybeExit();
}

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  handle(message);
});

// Leaving immediately on EOF would discard a response still in flight; wait for
// answers to our own client-facing requests, but never longer than the deadline.
let closing = false;
let closeDeadline = null;

function maybeExit() {
  if (!closing) return;
  if (outboundRequests.size === 0) process.exit(0);
}

reader.on("close", () => {
  closing = true;
  maybeExit();
  closeDeadline = setTimeout(() => process.exit(0), 2_000);
  closeDeadline.unref?.();
});

process.on("exit", () => {
  if (!reportPath) return;
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch {
    // A dead temp dir during teardown is not worth failing the process over.
  }
});
