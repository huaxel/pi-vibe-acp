import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getSupportedThinkingLevels,
  type AssistantMessageEvent,
  type AuthContext,
  type Message,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createVibeProvider, VIBE_API_ID, VIBE_PROVIDER_ID } from "../extensions/lib/provider.js";
import {
  buildThinkingLevelMap,
  discoverVibeModels,
  isVibeAcpAvailable,
  modelFromDiscovery,
} from "../extensions/lib/provider-models.js";
import {
  fingerprintMessages,
  renderColdPrompt,
  renderDeltaPrompt,
  subtractUsage,
  VibeSessionPool,
} from "../extensions/lib/provider-session.js";
import { FAKE_AGENT } from "./helpers.js";

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vibe-provider-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function systemMessage(text: string): Message {
  return { role: "system", content: text, timestamp: Date.now() };
}

function fakeModel(id = "fake-one"): Model<typeof VIBE_API_ID> {
  return modelFromDiscovery({
    id,
    name: `Fake (${id})`,
    thinkingLevels: ["off", "low", "high"],
  });
}

function authCtx(vars: Record<string, string | undefined> = {}): AuthContext {
  return {
    env: async (name) => vars[name],
    fileExists: async () => false,
  };
}

function transcript(messages: Message[]): TranscriptContext {
  return { messages } as TranscriptContext;
}

function textOf(events: AssistantMessageEvent[]): string {
  const last = events.at(-1);
  assert.equal(last?.type, "done");
  const message = (last as Extract<AssistantMessageEvent, { type: "done" }>).message;
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function collectEvents(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

test("buildThinkingLevelMap marks unsupported levels null so Pi only offers advertised ones", () => {
  const large = modelFromDiscovery({
    id: "mistral-large-4-0",
    name: "Mistral Large 4",
    thinkingLevels: ["low", "medium", "high"],
  });
  assert.deepEqual(getSupportedThinkingLevels(large), ["low", "medium", "high"]);

  const medium = modelFromDiscovery({
    id: "mistral-medium-latest",
    name: "Mistral Medium",
    thinkingLevels: ["off", "high"],
  });
  assert.deepEqual(getSupportedThinkingLevels(medium), ["off", "high"]);

  const noThinking = modelFromDiscovery({
    id: "plain",
    name: "Plain",
    thinkingLevels: ["off"],
  });
  assert.equal(noThinking.reasoning, false);
  assert.equal(buildThinkingLevelMap(["off"]), undefined);
  assert.deepEqual(getSupportedThinkingLevels(noThinking), ["off"]);
});

test("isVibeAcpAvailable detects an executable binary and rejects missing ones", () => {
  assert.equal(isVibeAcpAvailable(process.execPath), true);
  assert.equal(isVibeAcpAvailable("/definitely/missing/vibe-acp-binary"), false);
});

test("discoverVibeModels queries models and per-model thinking levels over ACP", withTempDir(async (dir) => {
  const reportPath = join(dir, "report.json");
  const models = await discoverVibeModels({
    cwd: dir,
    command: process.execPath,
    args: [FAKE_AGENT, "--report", reportPath],
  });

  assert.equal(models.length, 2);
  assert.deepEqual(models.map((m) => m.id), ["fake-one", "fake-two"]);
  assert.equal(models[0].provider, VIBE_PROVIDER_ID);
  assert.equal(models[0].api, VIBE_API_ID);
  assert.deepEqual(getSupportedThinkingLevels(models[0]), ["off", "low", "high"]);

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.closeSession, true);
  // fake-one is already current on session/new: switch to fake-two to probe thinking,
  // then restore fake-one so ~/.vibe/config.toml is left untouched.
  assert.deepEqual(report.configOptions, [
    { configId: "model", value: "fake-two" },
    { configId: "model", value: "fake-one" },
  ]);
}));

test("subtractUsage computes per-turn token deltas from session-cumulative counts", () => {
  const first = subtractUsage(
    { inputTokens: 100, outputTokens: 25, totalTokens: 125, cachedReadTokens: 10 },
    undefined,
  );
  assert.deepEqual(first, { inputTokens: 100, outputTokens: 25, totalTokens: 125, cachedReadTokens: 10 });

  const second = subtractUsage(
    { inputTokens: 240, outputTokens: 60, totalTokens: 300, cachedReadTokens: 30 },
    { inputTokens: 100, outputTokens: 25, totalTokens: 125, cachedReadTokens: 10 },
  );
  assert.deepEqual(second, { inputTokens: 140, outputTokens: 35, totalTokens: 175, cachedReadTokens: 20 });
});

test("prompt renderers format cold transcripts and keep single-user deltas clean", () => {
  const cold = renderColdPrompt("Be concise.", [userMessage("Hello")]);
  assert.match(cold, /<system_instructions>\nBe concise\.\n<\/system_instructions>/);
  assert.match(cold, /Hello$/);

  const delta = renderDeltaPrompt([userMessage("Follow up")]);
  assert.equal(delta, "Follow up");

  const fp1 = fingerprintMessages([userMessage("a")]);
  const fp2 = fingerprintMessages([userMessage("b")]);
  assert.notEqual(fp1, fp2);
});

test("provider streams thinking, text, status, and reuses warm session with delta usage", withTempDir(async (dir) => {
  const reportPath = join(dir, "report.json");
  const pool = new VibeSessionPool();
  const statuses: Array<string | undefined> = [];

  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({ permission: "deny" }),
    ui: {
      hasUI: () => false,
      setStatus: (_key, text) => statuses.push(text),
    },
    args: [FAKE_AGENT, "--behavior", "provider-multi", "--report", reportPath],
  });

  // Resolve provider env so VIBE_ACP_BIN points to node.
  await provider.auth.apiKey!.resolve({
    ctx: authCtx({ VIBE_ACP_BIN: process.execPath }),
    signal: new AbortController().signal,
  });

  const model = fakeModel("fake-one");
  const turn1Messages: Message[] = [systemMessage("Stay brief."), userMessage("First question")];
  const stream1 = provider.streamSimple!(model, transcript(turn1Messages), { reasoning: "high" });
  const events1 = await collectEvents(stream1);

  const done1 = events1.at(-1);
  assert.equal(done1?.type, "done");
  const msg1 = (done1 as Extract<AssistantMessageEvent, { type: "done" }>).message;
  assert.equal(msg1.stopReason, "stop");
  assert.equal(msg1.content[0]?.type, "thinking");
  assert.equal(msg1.content[1]?.type, "text");
  assert.match((msg1.content[1] as { text: string }).text, /reply 1:/);
  assert.equal(msg1.usage.input, 100);
  assert.equal(msg1.usage.output, 25);
  assert.equal(msg1.usage.cacheRead, 10);
  assert.equal(msg1.usage.totalTokens, 125);
  assert.ok(statuses.some((s) => s?.includes("read: file-1.ts")));
  assert.equal(statuses.at(-1), undefined);

  // Turn 2 continues the same transcript: should reuse the warm session and send only the delta!
  const turn2Messages: Message[] = [...turn1Messages, msg1, userMessage("Second question")];
  const stream2 = provider.streamSimple!(model, transcript(turn2Messages), { reasoning: "high" });
  const events2 = await collectEvents(stream2);

  const done2 = events2.at(-1);
  assert.equal(done2?.type, "done");
  const msg2 = (done2 as Extract<AssistantMessageEvent, { type: "done" }>).message;
  assert.equal((msg2.content[1] as { text: string }).text, "reply 2: Second question");
  // Turn 2 delta: 200-100=100 in, 50-25=25 out, 20-10=10 cached.
  assert.equal(msg2.usage.input, 100);
  assert.equal(msg2.usage.output, 25);
  assert.equal(msg2.usage.cacheRead, 10);
  assert.equal(msg2.usage.totalTokens, 125);

  await pool.reset();
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.prompts.length, 2);
  assert.match(report.prompts[0], /Stay brief\./);
  assert.equal(report.prompts[1], "Second question");
  assert.equal(report.closeSession, true);
}));

test("provider starts a fresh session when the transcript diverges", withTempDir(async (dir) => {
  const pool = new VibeSessionPool();
  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({ permission: "deny" }),
    args: [FAKE_AGENT, "--behavior", "provider-multi"],
  });

  await provider.auth.apiKey!.resolve({
    ctx: authCtx({ VIBE_ACP_BIN: process.execPath }),
    signal: new AbortController().signal,
  });

  const model = fakeModel("fake-one");
  const turn1Messages: Message[] = [systemMessage("Sys A"), userMessage("Turn 1")];
  const events1 = await collectEvents(provider.streamSimple!(model, transcript(turn1Messages)));
  const msg1 = (events1.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;

  // Diverge by changing system prompt (e.g., compaction or mode switch).
  const divergedMessages: Message[] = [systemMessage("Sys B"), userMessage("Turn 1"), msg1, userMessage("Turn 2")];
  const events2 = await collectEvents(provider.streamSimple!(model, transcript(divergedMessages)));
  const msg2 = (events2.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
  // Fresh agent process starts turnCount back at 1.
  assert.match((msg2.content[1] as { text: string }).text, /reply 1:/);

  await pool.reset();
}));

test("provider asks UI for permission when interactive and cancels cleanly on abort", withTempDir(async (dir) => {
  const reportPath = join(dir, "report.json");
  const pool = new VibeSessionPool();
  const prompts: string[] = [];

  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({}),
    ui: {
      hasUI: () => true,
      confirm: async (title, message) => {
        prompts.push(`${title}: ${message}`);
        return true;
      },
    },
    args: [FAKE_AGENT, "--report", reportPath],
  });

  await provider.auth.apiKey!.resolve({
    ctx: authCtx({ VIBE_ACP_BIN: process.execPath }),
    signal: new AbortController().signal,
  });

  const model = fakeModel("fake-one");
  const events = await collectEvents(
    provider.streamSimple!(model, transcript([userMessage("Run ls")])),
  );
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /bash: ls -la/);

  await pool.reset();
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(report.permissionOutcomes, ["selected:allow_once"]);
}));

test("provider aborts cleanly and drops the warm session", withTempDir(async (dir) => {
  const pool = new VibeSessionPool();
  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({ permission: "deny" }),
    args: [FAKE_AGENT, "--behavior", "slow"],
    abortGraceMs: 500,
  });

  await provider.auth.apiKey!.resolve({
    ctx: authCtx({ VIBE_ACP_BIN: process.execPath }),
    signal: new AbortController().signal,
  });

  const controller = new AbortController();
  const model = fakeModel("fake-one");
  const stream = provider.streamSimple!(
    model,
    transcript([userMessage("Slow task")]),
    { signal: controller.signal },
  );

  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "text_delta" && !controller.signal.aborted) {
      controller.abort();
    }
  }

  const end = events.at(-1);
  assert.equal(end?.type, "error");
  assert.equal((end as { reason: string }).reason, "aborted");
  assert.equal(pool.getStatus(dir), undefined);
}));

test("provider restores the persisted model when the warm session closes", withTempDir(async (dir) => {
  const reportPath = join(dir, "report.json");
  const pool = new VibeSessionPool();
  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({ permission: "deny" }),
    args: [FAKE_AGENT, "--report", reportPath],
  });

  await provider.auth.apiKey!.resolve({
    ctx: authCtx({ VIBE_ACP_BIN: process.execPath }),
    signal: new AbortController().signal,
  });

  // fake-one is the agent's persisted model; ask for fake-two instead.
  const other = modelFromDiscovery({ id: "fake-two", name: "Fake two", thinkingLevels: ["off", "low", "high"] });
  const events = await collectEvents(
    provider.streamSimple!(other, transcript([userMessage("Switch models")])),
  );
  assert.equal(events.at(-1)?.type, "done");

  await pool.reset();
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  // ACP has no session-scoped model option, so the switch persisted to the
  // user's config; closing the session must put the original value back.
  assert.deepEqual(report.configOptions, [
    { configId: "model", value: "fake-two" },
    { configId: "model", value: "fake-one" },
  ]);
}));

test("provider keeps the persisted model when the turn never changed it", withTempDir(async (dir) => {
  const reportPath = join(dir, "report.json");
  const pool = new VibeSessionPool();
  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({ permission: "deny" }),
    args: [FAKE_AGENT, "--report", reportPath],
  });

  await provider.auth.apiKey!.resolve({
    ctx: authCtx({ VIBE_ACP_BIN: process.execPath }),
    signal: new AbortController().signal,
  });

  const events = await collectEvents(
    provider.streamSimple!(fakeModel("fake-one"), transcript([userMessage("Stay put")])),
  );
  assert.equal(events.at(-1)?.type, "done");

  await pool.reset();
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(report.configOptions, []);
}));

test("provider serializes concurrent turns so one ACP session never takes two prompts", withTempDir(async (dir) => {
  const reportPath = join(dir, "report.json");
  const pool = new VibeSessionPool();
  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({ permission: "deny" }),
    args: [FAKE_AGENT, "--behavior", "provider-overlap", "--report", reportPath],
  });

  await provider.auth.apiKey!.resolve({
    ctx: authCtx({ VIBE_ACP_BIN: process.execPath }),
    signal: new AbortController().signal,
  });

  const model = fakeModel("fake-one");
  const [first, second] = await Promise.all([
    collectEvents(provider.streamSimple!(model, transcript([userMessage("First")]))),
    collectEvents(provider.streamSimple!(model, transcript([userMessage("Second")]))),
  ]);

  // Both turns must answer their own prompt: an unserialized pair overwrites the
  // active callback map, so one stream loses its text entirely.
  assert.match(textOf(first), /First$/);
  assert.match(textOf(second), /Second$/);

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.overlaps, 0, "the pool let two prompts run on one session at once");

  await pool.reset();
}));

test("provider auth check hides provider when vibe-acp is missing", async () => {
  const pool = new VibeSessionPool();
  const provider = createVibeProvider({
    pool,
    getCwd: () => process.cwd(),
    getSettings: () => ({}),
    checkAvailable: () => false,
  });

  const status = await provider.auth.apiKey!.check!({
    ctx: authCtx(),
    signal: new AbortController().signal,
  });
  assert.equal(status, undefined);
});
