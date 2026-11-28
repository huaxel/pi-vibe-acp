/**
 * Live smoke test for the Pi-native `vibe` provider against the real `vibe-acp`.
 *
 * Spends three minimal Vibe turns, so it is not part of `npm test`:
 *
 *   npm run test:live:provider
 *
 * It proves what the offline suite can only prove against a scripted agent:
 *
 *   1. live model discovery reports each model with the thinking levels Vibe
 *      really advertises, without leaving the user's default model changed;
 *   2. a provider turn streams incremental text deltas through Pi's event API
 *      and closes with a `done` event carrying non-zero usage;
 *   3. even with Pi tools advertised, Vibe-native actions still honor the
 *      configured approval prompt (vibe-acp 3.1.5 ignores client tools);
 *   4. a second turn in the same transcript reuses the *same* ACP session and
 *      bills only the incremental delta, not the whole conversation again.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSupportedThinkingLevels,
  type AssistantMessage,
  type ThinkingLevel,
  type AssistantMessageEvent,
  type Message,
  type ToolCall,
  type ToolResultMessage,
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

function systemWithTools(): Message {
  return {
    role: "system",
    content: "Work in the given directory.",
    toolsAdded: [
      { name: "write", description: "Write a file", parameters: {} },
      { name: "bash", description: "Run a shell command", parameters: {} },
    ],
    timestamp: Date.now(),
  };
}

function toolResultMessage(toolCallId: string, text: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName: "tool", content: [{ type: "text", text }], isError, timestamp: Date.now() };
}

/**
 * Stand in for Pi's tool loop: actually perform what the turn asked for, in the
 * same way Pi's own tools would, so the agent's next turn sees a real result.
 */
function performToolCall(call: ToolCall, dir: string): ToolResultMessage {
  if (call.name === "write") {
    const path = join(dir, String(call.arguments.path));
    writeFileSync(path, String(call.arguments.content ?? ""));
    return toolResultMessage(call.id, `Wrote ${call.arguments.path}`);
  }
  if (call.name === "bash") {
    const result = spawnSync("bash", ["-c", String(call.arguments.command ?? "")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const code = result.status ?? 1;
    // Same convention as Pi's bash tool, which the bridge parses back.
    return code === 0
      ? toolResultMessage(call.id, output)
      : toolResultMessage(call.id, `${output}\n\nCommand exited with code ${code}`, true);
  }
  throw new Error(`unexpected tool call ${call.name}`);
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

// --- 2. ensure bridge opt-in does not suppress Vibe-native approval --------
await verifyNativeApproval(model, getSupportedThinkingLevels(model).find((level) => level !== "off"));

// --- 3. two provider turns in an isolated workspace -----------------------
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

  // --- delegation: only with an explicit opt-in -----------------------------
  // vibe-acp 3.1.5 never routes file or shell work through an ACP client: its
  // harness file-system executor is a native constant with no client mode, so
  // advertising the capability is inert. The path is implemented and covered
  // offline; this section only runs when the opt-in is set, in its own workspace
  // because capabilities are fixed at `initialize` and would rebuild the warm
  // session measured above.
  if (process.env.PI_VIBE_ACP_CLIENT_TOOLS?.trim() === "1") {
    console.log("== turn 1b: delegate a write and a command to Pi ==");
    await verifyDelegation(model, reasoning);
  } else {
    console.log("== turn 1b: delegation skipped (set PI_VIBE_ACP_CLIENT_TOOLS=1 to enable) ==");
  }

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

/**
 * Advertise client tools and check what the agent does with them.
 *
 * Runs in its own workspace and session pool: the tool set is negotiated at
 * `initialize`, so mixing it into the turns above would replace their session.
 */
async function verifyNativeApproval(model: VibeModel, reasoning: ThinkingLevel | undefined): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-vibe-live-approval-"));
  const markerPath = join(dir, "approval-marker");
  const command = `printf '%s' 'P' >> '${markerPath.replaceAll("'", "'\\''")}'`;
  const pool = new VibeSessionPool();
  let prompts = 0;
  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({ mode: "ask", permission: "ask" }),
    ui: {
      hasUI: () => true,
      confirm: async () => {
        prompts += 1;
        return true;
      },
    },
  });
  try {
    await provider.auth.apiKey!.resolve({
      ctx: {
        env: async (name) => name === "PI_VIBE_ACP_CLIENT_TOOLS" ? "1" : process.env[name],
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    });
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const events = await collect(provider.streamSimple!(
      model,
      transcript([
        systemWithTools(),
        userMessage(`Run this exact shell command twice, sequentially, using the shell tool each time, then stop: ${command}`),
      ]),
      { ...(reasoning ? { reasoning } : {}), signal: timeout },
    ));
    const message = finish(events, timeout);
    console.log("== approval with advertised Pi tools ==");
    console.log("Pi confirmation callbacks:", prompts, "marker:", existsSync(markerPath));
    if (message.stopReason !== "stop") fail(`approval probe stop reason ${message.stopReason}`);
    if (prompts !== 1) fail(`expected one session-scoped approval for repeated identical actions, got ${prompts}`);
    if (readFileSync(markerPath, "utf8") !== "PP") {
      fail("the approved command did not execute exactly twice");
    }
  } finally {
    await pool.reset();
    await rm(dir, { recursive: true, force: true });
  }
}

async function verifyDelegation(model: VibeModel, reasoning: ThinkingLevel | undefined): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-vibe-live-delegate-"));
  const pool = new VibeSessionPool();
  const provider = createVibeProvider({
    pool,
    getCwd: () => dir,
    getSettings: () => ({ permission: "deny" }),
    ui: { hasUI: () => false },
  });
  try {
    await provider.auth.apiKey!.resolve({
      ctx: { env: async (name) => process.env[name], fileExists: async () => false },
      signal: new AbortController().signal,
    });

    const messages: Message[] = [
      systemWithTools(),
      userMessage(
        "Create a file named delegated.txt containing exactly the word DELEGATED, then run " +
          "`wc -c < delegated.txt` and tell me the number it prints. Do not use any other tool.",
      ),
    ];
    const delegatedCalls: ToolCall[] = [];
    let final: AssistantMessage | undefined;
    for (let step = 0; step < 6; step += 1) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const events = await collect(
        provider.streamSimple!(model, transcript(messages), { ...(reasoning ? { reasoning } : {}), signal: timeout }),
      );
      const message = finish(events, timeout);
      if (message.stopReason !== "toolUse") {
        final = message;
        break;
      }
      const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
      if (calls.length === 0) fail("turn reported toolUse but carried no tool call");
      messages.push(message);
      for (const call of calls) {
        delegatedCalls.push(call);
        messages.push(performToolCall(call, dir));
      }
    }

    const text = final ? textOf(final) : "";
    console.log("delegated calls:", delegatedCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join(", ") || "none");
    console.log("final text:", JSON.stringify(text.trim().slice(0, 160)));
    console.log("files:", existsSync(join(dir, "delegated.txt")) ? "delegated.txt written" : "no delegated.txt");

    if (delegatedCalls.length === 0) {
      // Advertising must be inert: the turn still completes and the agent still
      // does the work itself. Asserting delegation here would fail this smoke
      // against every shipping agent.
      if (!existsSync(join(dir, "delegated.txt"))) fail("the file was never created by either side");
      if (text.trim().length === 0) fail("an inert advertisement broke the turn's final text");
      console.log("delegation: advertised but unused by this agent version (harmless)");
    } else {
      if (!delegatedCalls.some((call) => call.name === "write")) fail("no write was delegated to Pi");
      if (!delegatedCalls.some((call) => call.name === "bash")) fail("no command was delegated to Pi");
      if (readFileSync(join(dir, "delegated.txt"), "utf8").trim() !== "DELEGATED") {
        fail("the delegated write stored the wrong content");
      }
      console.log("delegation: active");
    }
  } finally {
    await pool.reset();
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("live provider smoke ok");
