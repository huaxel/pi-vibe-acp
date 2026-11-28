/**
 * Live smoke test for the Pi-native `vibe` provider against the real `vibe-acp`.
 *
 * Spends two minimal Vibe turns, so it is not part of `npm test`:
 *
 *   npm run test:live:provider
 *
 * It proves what the offline suite can only prove against a scripted agent:
 *
 *   1. live model discovery reports each model with the thinking levels Vibe
 *      really advertises, without leaving the user's default model changed;
 *   2. a provider turn streams incremental text deltas through Pi's event API
 *      and closes with a `done` event carrying non-zero usage;
 *   3. a second turn in the same transcript reuses the *same* ACP session and
 *      bills only the incremental delta, not the whole conversation again.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSupportedThinkingLevels,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createVibeProvider,
  VIBE_API_ID,
  VIBE_PROVIDER_ID,
} from "../extensions/lib/provider.js";
import { discoverVibeModels, type VibeModel } from "../extensions/lib/provider-models.js";
import { VibeSessionPool } from "../extensions/lib/provider-session.js";

const TIMEOUT_MS = 180_000;
/** Prefer a fast model for the smoke; override with PI_VIBE_LIVE_MODEL. */
const PREFERRED_MODELS = ["mistral-medium-latest", "zai-glm-5-3-flash"];

function fail(message: string): never {
  throw new Error(`live provider smoke failed: ${message}`);
}
function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function transcript(messages: Message[]): TranscriptContext {
  return { messages } as TranscriptContext;
}

async function collect(
  stream: AsyncIterable<AssistantMessageEvent>,
  onEvent?: (event: AssistantMessageEvent) => void,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

function finish(events: AssistantMessageEvent[], timeoutSignal: AbortSignal): AssistantMessage {
  const last = events.at(-1);
  if (last?.type !== "done") {
    const error = last as Extract<AssistantMessageEvent, { type: "error" }> | undefined;
    const timedOut = timeoutSignal.aborted && (timeoutSignal.reason as { name?: string })?.name === "TimeoutError";
    fail(
      `turn ended with ${last?.type ?? "no event"}: ${error?.error?.errorMessage ?? "no error message"}${
        timedOut ? ` (no answer within ${TIMEOUT_MS}ms)` : ""
      }`,
    );
  }
  return last.message;
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// --- 1. live discovery: no model turn -------------------------------------
console.log("== discovery (no model turn) ==");
const discovered = await discoverVibeModels({ cwd: process.cwd() });
if (discovered.length === 0) fail("discovery returned no models");
for (const model of discovered) {
  console.log(
    `${model.id} | ${model.name} | reasoning: ${model.reasoning} | levels: ${getSupportedThinkingLevels(model).join(",") || "none"}`,
  );
  if (model.provider !== VIBE_PROVIDER_ID || model.api !== VIBE_API_ID) {
    fail(`model ${model.id} was not tagged as a ${VIBE_PROVIDER_ID}/${VIBE_API_ID} model`);
  }
}

const wanted = process.env.PI_VIBE_LIVE_MODEL?.trim();
const model: VibeModel | undefined = wanted
  ? discovered.find((candidate) => candidate.id === wanted)
  : PREFERRED_MODELS.map((id) => discovered.find((candidate) => candidate.id === id)).find(Boolean) ??
    discovered[0];
if (!model) fail(`no discovered model matches PI_VIBE_LIVE_MODEL=${wanted}`);
console.log("using model:", model.id);

// --- 2. two provider turns in an isolated workspace -----------------------
const dir = await mkdtemp(join(tmpdir(), "pi-vibe-live-provider-"));
const pool = new VibeSessionPool();
const statuses: string[] = [];
const provider = createVibeProvider({
  pool,
  getCwd: () => dir,
  getSettings: () => ({ permission: "deny" }),
  ui: {
    hasUI: () => false,
    setStatus: (_key, text) => statuses.push(text ?? ""),
  },
});

try {
  await provider.auth.apiKey!.resolve({
    ctx: { env: async (name) => process.env[name], fileExists: async () => false },
    signal: new AbortController().signal,
  });

  const levels = getSupportedThinkingLevels(model);
  const reasoning = levels.find((level) => level !== "off");

  console.log(`== turn 1/2: stream a reply (thinking: ${reasoning ?? "off"}) ==`);
  const turn1: Message[] = [
    userMessage("Write a five sentence paragraph about the sea, in plain prose. No lists."),
  ];
  const timeout1 = AbortSignal.timeout(TIMEOUT_MS);
  let firstTextAt = 0;
  let textDeltas = 0;
  let textChars = 0;
  const startedAt = Date.now();
  const events1 = await collect(
    provider.streamSimple!(model, transcript(turn1), { ...(reasoning ? { reasoning } : {}), signal: timeout1 }),
    (event) => {
      if (event.type !== "text_delta") return;
      textDeltas += 1;
      textChars += event.delta.length;
      if (firstTextAt === 0) firstTextAt = Date.now();
    },
  );
  const doneAt = Date.now();
  const message1 = finish(events1, timeout1);
  const text1 = textOf(message1);
  const leadMs = firstTextAt === 0 ? 0 : doneAt - firstTextAt;
  console.log("text:", JSON.stringify(text1.trim().slice(0, 120)));
  console.log(
    "text deltas:",
    textDeltas,
    `(${textChars} chars)`,
    "first text after:",
    `${firstTextAt - startedAt}ms`,
    "before done:",
    `${leadMs}ms`,
  );
  console.log("usage:", message1.usage, "stopReason:", message1.stopReason);

  if (message1.stopReason !== "stop") fail(`turn 1 stop reason ${message1.stopReason}`);
  if (!text1.trim()) fail("turn 1 produced no assistant text");
  if (message1.usage.totalTokens <= 0) fail("turn 1 reported no token usage");
  // Streaming means text reached Pi as it was produced. Chunk counts are up to
  // the agent, so accept either many chunks or a first chunk that clearly
  // arrived before the turn finished.
  if (textDeltas < 2 && leadMs < 500) {
    fail(`turn 1 delivered ${textDeltas} text delta(s) only ${leadMs}ms before done, so it was buffered, not streamed`);
  }

  const sessionAfterTurn1 = pool.getStatus(dir);
  if (!sessionAfterTurn1) fail("turn 1 left no warm session to reuse");

  console.log("== turn 2/2: same transcript, delta-only prompt ==");
  const turn2: Message[] = [...turn1, message1, userMessage("Reply with exactly: OK2")];
  const startedTurn2 = Date.now();
  const timeout2 = AbortSignal.timeout(TIMEOUT_MS);
  const events2 = await collect(
    provider.streamSimple!(model, transcript(turn2), { ...(reasoning ? { reasoning } : {}), signal: timeout2 }),
  );
  const message2 = finish(events2, timeout2);
  const text2 = textOf(message2);
  const sessionAfterTurn2 = pool.getStatus(dir);
  console.log("text:", JSON.stringify(text2.trim()));
  console.log("usage delta:", message2.usage, "cumulative:", sessionAfterTurn2?.cumulativeUsage);
  console.log("wall:", `${Date.now() - startedTurn2}ms`);

  if (message2.stopReason !== "stop") fail(`turn 2 stop reason ${message2.stopReason}`);
  if (!text2.trim()) fail("turn 2 produced no assistant text");
  if (!sessionAfterTurn2) fail("turn 2 dropped the warm session");
  // Same ACP session id means the follow-up continued Vibe's live conversation
  // instead of paying for a cold replay of the whole transcript.
  if (sessionAfterTurn2.sessionId !== sessionAfterTurn1.sessionId) {
    fail(
      `turn 2 opened session ${sessionAfterTurn2.sessionId} instead of reusing ${sessionAfterTurn1.sessionId}`,
    );
  }
  const cumulative = sessionAfterTurn2.cumulativeUsage?.totalTokens ?? 0;
  if (cumulative <= message2.usage.totalTokens) {
    fail(
      `turn 2 billed ${message2.usage.totalTokens} of ${cumulative} cumulative tokens, so it replayed the transcript`,
    );
  }
  console.log(`reuse ok: session ${sessionAfterTurn2.sessionId} billed ${message2.usage.totalTokens} of ${cumulative} cumulative tokens`);
} finally {
  await pool.reset();
  if (pool.getStatus(dir)) fail("pool reset left a warm session behind");
  await rm(dir, { recursive: true, force: true });
}

console.log("live provider smoke ok");
