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
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "tool-1", title: "bash: ls -la", kind: "execute", status: "pending" },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}

function finishTurn(promptId, sessionId) {
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "world" },
  });
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

  if (behavior === "hang") {
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
      respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "@mistralai/mistral-vibe", title: "Mistral Vibe", version: "3.1.4-fake" },
        agentCapabilities: { loadSession: true },
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
        configOptions: options,
      });
      return;

    case "session/set_config_option": {
      const { configId, value } = message.params ?? {};
      const option = options.find((candidate) => candidate.id === configId);
      const allowed = (option?.options ?? []).map((choice) => choice.value);
      if (!option || !allowed.includes(value)) {
        respondError(message.id, -32602, `unsupported ${configId}=${value}`);
        return;
      }
      report.configOptions.push({ configId, value });
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
