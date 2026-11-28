import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AuthContext,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { CLIENT_METHODS } from "../extensions/lib/protocol.js";
import type { DeferredClientRequest } from "../extensions/lib/acp-client.js";
import {
  buildCommand,
  planClientRequest,
  readTerminalOutcome,
  settleClientResult,
  TerminalRegistry,
} from "../extensions/lib/client-bridge.js";
import {
  availableToolNames,
  createVibeProvider,
  deriveCapabilities,
  VIBE_API_ID,
} from "../extensions/lib/provider.js";
import { modelFromDiscovery } from "../extensions/lib/provider-models.js";
import { isClientMethodAdvertised, VibeSessionPool } from "../extensions/lib/provider-session.js";
import { FAKE_AGENT } from "./helpers.js";

test("client methods are limited to capabilities negotiated at initialize", () => {
  assert.equal(isClientMethodAdvertised(CLIENT_METHODS.fsWriteTextFile, "write"), true);
  assert.equal(isClientMethodAdvertised(CLIENT_METHODS.terminalCreate, "write"), false);
  assert.equal(isClientMethodAdvertised(CLIENT_METHODS.fsWriteTextFile, "terminal"), false);
  assert.equal(isClientMethodAdvertised(CLIENT_METHODS.terminalCreate, "terminal"), true);
  assert.equal(isClientMethodAdvertised(CLIENT_METHODS.terminalOutput, "terminal"), true);
  assert.equal(isClientMethodAdvertised(CLIENT_METHODS.fsReadTextFile, "write,terminal"), false);
  assert.equal(isClientMethodAdvertised("unknown/method", "write,terminal"), false);
});

function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function systemMessage(text: string, tools: string[] = []): Message {
  return {
    role: "system",
    content: text,
    ...(tools.length > 0 ? { toolsAdded: tools.map((name) => ({ name, description: name, parameters: {} })) } : {}),
    timestamp: Date.now(),
  };
}

function toolResult(toolCallId: string, text: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "tool",
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

function fakeModel(id = "fake-one"): Model<typeof VIBE_API_ID> {
  return modelFromDiscovery({ id, name: `Fake (${id})`, thinkingLevels: ["off", "low", "high"] });
}

function authCtx(vars: Record<string, string | undefined> = {}): AuthContext {
  return { env: async (name) => vars[name], fileExists: async () => false };
}

function transcript(messages: Message[]): TranscriptContext {
  return { messages } as TranscriptContext;
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const last = events.at(-1);
  assert.equal(last?.type, "done", `expected done, got ${last?.type}`);
  return (last as Extract<AssistantMessageEvent, { type: "done" }>).message;
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function recordingDeferred(): DeferredClientRequest & {
  settled: unknown[];
  failed: string[];
} {
  const settled: unknown[] = [];
  const failed: string[] = [];
  return {
    id: 1,
    method: "test",
    settled,
    failed,
    settle: (result) => settled.push(result),
    fail: (message) => failed.push(message),
  };
}

test("capabilities follow the Pi tools actually present", () => {
  assert.equal(deriveCapabilities([systemMessage("x", ["read"])]), undefined);
  assert.deepEqual(deriveCapabilities([systemMessage("x", ["write"])]), {
    fs: { writeTextFile: true },
    terminal: false,
  });
  assert.deepEqual(deriveCapabilities([systemMessage("x", ["write", "bash"])]), {
    fs: { writeTextFile: true },
    terminal: true,
  });
});

test("tools removed later are no longer advertised", () => {
  const messages: Message[] = [
    systemMessage("x", ["write", "bash"]),
    { role: "system", content: "later", toolsRemoved: [{ name: "bash" }], timestamp: Date.now() },
  ];
  assert.deepEqual([...availableToolNames(messages)], ["write"]);
  assert.deepEqual(deriveCapabilities(messages), { fs: { writeTextFile: true }, terminal: false });
});

test("commands are built without letting arguments leak into the shell", () => {
  assert.equal(
    buildCommand({ command: "printf", args: ["%s", "hello"] }),
    "printf %s hello",
  );
  // Spaces and metacharacters must stay one argument.
  assert.equal(
    buildCommand({ command: "echo", args: ["a b", "$(rm -rf /)", "it's"] }),
    "echo 'a b' '$(rm -rf /)' 'it'\\''s'",
  );
  assert.equal(
    buildCommand({ command: "ls", cwd: "/tmp/a b", env: [{ name: "K", value: "v v" }] }),
    "cd '/tmp/a b' && env 'K=v v' ls",
  );
});

test("a failing command that reports no exit code is still a failure", () => {
  assert.deepEqual(readTerminalOutcome(toolResult("id", "hello")), {
    output: "hello",
    truncated: false,
    exitCode: 0,
    signal: null,
  });
  // Pi appends the code to a non-zero result and marks it as an error.
  assert.deepEqual(readTerminalOutcome(toolResult("id", "boom\n\nCommand exited with code 2", true)), {
    output: "boom",
    truncated: false,
    exitCode: 2,
    signal: null,
  });
  // A failing command with no output starts with the marker, not a blank line.
  assert.deepEqual(readTerminalOutcome(toolResult("id", "Command exited with code 127", true)), {
    output: "",
    truncated: false,
    exitCode: 127,
    signal: null,
  });
  // Unreadable marker: never pass a failure off as success.
  assert.equal(readTerminalOutcome(toolResult("id", "boom", true)).exitCode, 1);
});

test("a malformed write fails instead of claiming success or wiping the file", () => {
  const terminals = new TerminalRegistry();
  const noPath = planClientRequest({
    method: CLIENT_METHODS.fsWriteTextFile,
    params: { sessionId: "s", content: "x" },
    deferred: recordingDeferred(),
    terminals,
  });
  assert.equal(noPath.kind, "immediate");
  if (noPath.kind !== "immediate") return;
  // Answering `{}` here would tell the agent the write landed.
  assert.equal(noPath.result, undefined);
  assert.match(noPath.error ?? "", /needs a path and string content/);

  const badContent = planClientRequest({
    method: CLIENT_METHODS.fsWriteTextFile,
    params: { sessionId: "s", path: "a.txt", content: 42 },
    deferred: recordingDeferred(),
    terminals,
  });
  assert.equal(badContent.kind, "immediate");
  // Coercing to "" would overwrite a.txt with zero bytes.
  if (badContent.kind !== "immediate") return;
  assert.equal(badContent.result, undefined);
});

test("truncated command output is reported as truncated, not as the whole story", () => {
  // Exactly what Pi's bash tool appends when it caps output.
  const marker = "[Showing lines 1-2000 of 9000 (50KB limit). Full output saved to: /tmp/pi-bash-abc.log]";
  const capped = readTerminalOutcome(toolResult("id", ["head", "", marker].join("\n")));
  assert.equal(capped.truncated, true);
  assert.doesNotMatch(capped.output, /Showing lines/);
  assert.match(capped.output, /head/);
  assert.equal(readTerminalOutcome(toolResult("id", "short", false)).truncated, false);
});

test("terminal state survives create, wait, output, and release", () => {
  const terminals = new TerminalRegistry();
  const deferred = recordingDeferred();
  const planned = planClientRequest({
    method: CLIENT_METHODS.terminalCreate,
    params: { sessionId: "s", command: "echo", args: ["hi"] },
    deferred,
    terminals,
  });
  assert.equal(planned.kind, "call");
  if (planned.kind !== "call") return;
  const terminalId = planned.call.terminalId!;

  settleClientResult({ call: planned.call, result: toolResult("x", "hi"), terminals });
  assert.deepEqual(deferred.settled, [{ terminalId }]);

  const wait = planClientRequest({
    method: CLIENT_METHODS.terminalWaitForExit,
    params: { sessionId: "s", terminalId },
    deferred: recordingDeferred(),
    terminals,
  });
  assert.deepEqual(wait, { kind: "immediate", result: { exitCode: 0, signal: null } });

  const output = planClientRequest({
    method: CLIENT_METHODS.terminalOutput,
    params: { sessionId: "s", terminalId },
    deferred: recordingDeferred(),
    terminals,
  });
  assert.deepEqual(output, { kind: "immediate", result: { output: "hi", truncated: false } });

  planClientRequest({
    method: CLIENT_METHODS.terminalRelease,
    params: { sessionId: "s", terminalId },
    deferred: recordingDeferred(),
    terminals,
  });
  assert.deepEqual(terminals.read(terminalId), {
    output: "",
    truncated: false,
    exitCode: null,
    signal: null,
  });
});

test("the terminal registry evicts old entries instead of growing without bound", () => {
  const terminals = new TerminalRegistry();
  for (let index = 0; index < 100; index += 1) {
    terminals.set(`term-${index}`, { output: `o${index}`, truncated: false, exitCode: 0, signal: null });
  }
  // The newest are kept; the earliest are gone rather than held forever.
  assert.equal(terminals.read("term-99").output, "o99");
  assert.equal(terminals.read("term-0").exitCode, null);
});

test("a rejected write is reported as an error, not as a successful write", () => {
  const terminals = new TerminalRegistry();
  const deferred = recordingDeferred();
  const planned = planClientRequest({
    method: CLIENT_METHODS.fsWriteTextFile,
    params: { sessionId: "s", path: "a.txt", content: "x" },
    deferred,
    terminals,
  });
  assert.equal(planned.kind, "call");
  if (planned.kind !== "call") return;
  settleClientResult({ call: planned.call, result: toolResult("x", "permission denied", true), terminals });
  assert.deepEqual(deferred.settled, []);
  assert.deepEqual(deferred.failed, ["permission denied"]);
});

test("a tool request outside negotiated capabilities is refused rather than bridged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vibe-bridge-scope-"));
  const pool = new VibeSessionPool();
  try {
    const provider = createVibeProvider({
      pool,
      getCwd: () => dir,
      getSettings: () => ({ permission: "approve" }),
      ui: { hasUI: () => false },
      args: [FAKE_AGENT, "--behavior", "client-tools"],
    });
    await provider.auth.apiKey!.resolve({
      ctx: authCtx({ VIBE_ACP_BIN: process.execPath, PI_VIBE_ACP_CLIENT_TOOLS: "1" }),
      signal: new AbortController().signal,
    });

    const model = fakeModel("fake-one");
    const base: Message[] = [systemMessage("Stay brief.", ["write"]), userMessage("do it")];
    const first = doneMessage(await collectEvents(provider.streamSimple!(model, transcript(base), {})));
    const [writeCall] = toolCallsOf(first);
    assert.equal(first.stopReason, "toolUse");
    assert.equal(writeCall?.name, "write");

    // The fake agent next asks for terminal/create, although this session only
    // negotiated fs.write_text_file. It must receive an error, not Pi's bash.
    const second = doneMessage(await collectEvents(provider.streamSimple!(
      model,
      transcript([...base, first, toolResult(writeCall.id, "Wrote note.txt")]),
      {},
    )));
    assert.equal(second.stopReason, "stop");
    assert.equal(toolCallsOf(second).length, 0);
    const finalText = second.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    assert.match(finalText, /write=ok/);
    assert.match(finalText, /exit=undefined/);
  } finally {
    await pool.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a parked turn whose action never arrives rebuilds the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vibe-bridge-abandon-"));
  const reportPath = join(dir, "report.json");
  const pool = new VibeSessionPool();
  try {
    const provider = createVibeProvider({
      pool,
      getCwd: () => dir,
      getSettings: () => ({ permission: "approve" }),
      ui: { hasUI: () => false },
      args: [FAKE_AGENT, "--behavior", "client-tools", "--report", reportPath],
    });
    await provider.auth.apiKey!.resolve({
      ctx: authCtx({ VIBE_ACP_BIN: process.execPath, PI_VIBE_ACP_CLIENT_TOOLS: "1" }),
      signal: new AbortController().signal,
    });

    const model = fakeModel("fake-one");
    const base: Message[] = [systemMessage("Stay brief.", ["write", "bash"]), userMessage("do it")];
    const first = doneMessage(await collectEvents(provider.streamSimple!(model, transcript(base), {})));
    assert.equal(first.stopReason, "toolUse");
    const parked = pool.getStatus(dir);
    assert.ok(parked, "the parked turn left no session to resume");

    // Pi never reported the action: an abort, a retry, or a brand new user turn.
    // Resuming would wait forever on a request nobody is left to answer, so the
    // suspended turn has to be cancelled and the workspace rebuilt.
    //
    // This guards the invariant, not one mechanism: the parked turn never commits
    // its sync state, so neither the eager cancel nor the reuse check alone can
    // be falsified through it. Both exist — the cancel stops the old agent before
    // a replacement starts, the sync check makes a silent resume impossible.
    const abandoned: Message[] = [...base, first, userMessage("never mind, do something else")];
    const second = doneMessage(await collectEvents(provider.streamSimple!(model, transcript(abandoned), {})));

    const rebuilt = pool.getStatus(dir);
    assert.ok(rebuilt, "the workspace was left with no usable session");
    assert.equal(second.stopReason, "toolUse");

    // Only a rebuilt session starts a new agent process, and a new process is
    // the only way the abandoned transcript gets sent as a cold prompt. The last
    // process to exit writes the report, so this reads the rebuilt one.
    await pool.reset();
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { prompts: string[] };
    assert.equal(report.prompts.length, 1);
    assert.match(report.prompts[0] ?? "", /never mind, do something else/);
  } finally {
    await pool.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Vibe's write and command become Pi tool calls, and Pi's results answer them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vibe-bridge-"));
  const reportPath = join(dir, "report.json");
  const pool = new VibeSessionPool();
  try {
    const provider = createVibeProvider({
      pool,
      getCwd: () => dir,
      getSettings: () => ({ permission: "approve" }),
      ui: { hasUI: () => false },
      args: [FAKE_AGENT, "--behavior", "client-tools", "--report", reportPath],
    });
    await provider.auth.apiKey!.resolve({
      ctx: authCtx({ VIBE_ACP_BIN: process.execPath, PI_VIBE_ACP_CLIENT_TOOLS: "1" }),
      signal: new AbortController().signal,
    });

    const model = fakeModel("fake-one");
    const base: Message[] = [systemMessage("Stay brief.", ["read", "write", "bash"]), userMessage("do it")];

    // Turn 1: Vibe asks for a file write, so the turn hands Pi a real write call.
    const first = doneMessage(await collectEvents(provider.streamSimple!(model, transcript(base), {})));
    assert.equal(first.stopReason, "toolUse");
    const writeCalls = toolCallsOf(first);
    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0].name, "write");
    assert.deepEqual(writeCalls[0].arguments, {
      path: "note.txt",
      content: "written by the client\n",
    });

    // Turn 2: Pi reports the write, so Vibe proceeds to run its command.
    const second = doneMessage(
      await collectEvents(
        provider.streamSimple!(
          model,
          transcript([...base, first, toolResult(writeCalls[0].id, "Wrote note.txt")]),
          {},
        ),
      ),
    );
    assert.equal(second.stopReason, "toolUse");
    const bashCalls = toolCallsOf(second);
    assert.equal(bashCalls.length, 1);
    assert.equal(bashCalls[0].name, "bash");
    assert.equal(bashCalls[0].arguments.command, "env GREETING=hi printf %s hello");

    // Turn 3: Pi reports the command, so Vibe can answer with what happened.
    const third = doneMessage(
      await collectEvents(
        provider.streamSimple!(
          model,
          transcript([...base, first, toolResult(writeCalls[0].id, "Wrote note.txt"), second, toolResult(bashCalls[0].id, "hello")]),
          {},
        ),
      ),
    );
    assert.equal(third.stopReason, "stop");
    const text = third.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    assert.match(text, /write=ok/);
    assert.match(text, /exit=0/);
    assert.match(text, /out=hello/);
    // One Vibe session served all three Pi turns.
    assert.equal(third.usage.input, 12);
  } finally {
    await pool.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});
