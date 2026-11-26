/**
 * Live smoke test against the real `vibe-acp`.
 *
 * Spends a small amount of Vibe usage (three minimal turns), so it is not part of
 * `npm test`. Run it after installing Mistral Vibe:
 *
 *   npm run test:live
 *
 * It covers the three paths the offline suite can only prove against a scripted
 * agent, which is why it costs three turns instead of one:
 *
 *   1. a normal turn that answers with text;
 *   2. an approved tool call, proven by the command's output reaching the
 *      transcript (a denied tool call would produce no output at all);
 *   3. a cancel that lands inside the agent's abort grace window and leaves no
 *      child process behind.
 *
 * The doctor step costs no model turn.
 */
import { execFileSync } from "node:child_process";
import { readVibeDoctor, runVibeTask } from "../extensions/lib/vibe.js";

const cwd = process.cwd();
/** Abort this long into turn 3 if no assistant text has arrived yet. */
const ABORT_FALLBACK_MS = 20_000;
/** The agent's cancel acknowledgement must land inside this window. */
const ABORT_GRACE_MS = 5_000;
const TIMEOUT_MS = 180_000;

function fail(message: string): never {
  throw new Error(`live smoke failed: ${message}`);
}

/**
 * PIDs of this process's direct children, or undefined when `pgrep` is missing
 * (for example on Windows) so the orphan check can be skipped rather than guessed.
 */
function childPids(): string[] | undefined {
  try {
    return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    // `pgrep` exits 1 when nothing matched, which is the healthy case.
    if ((error as { status?: number }).status === 1) return [];
    return undefined;
  }
}

/** Wait briefly for killed children to be reaped before calling them leaked. */
async function childrenAfterExit(timeoutMs = 2_000): Promise<string[] | undefined> {
  const deadline = Date.now() + timeoutMs;
  let remaining = childPids();
  while (remaining && remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = childPids();
  }
  return remaining;
}

// --- 1. identity, auth methods, session options: no model turn -------------
console.log("== doctor (no model turn) ==");
const doctor = await readVibeDoctor({ cwd });
console.log("agent:", doctor.agent);
console.log("protocol:", doctor.protocolVersion);
console.log("auth methods:", doctor.authMethods);
console.log(
  "options:",
  doctor.configOptions.map((option) => `${option.id}=${String(option.currentValue)}`),
);

// --- 2. turn 1/3: a plain answer ------------------------------------------
console.log("== turn 1/3: normal reply ==");
const startedAt = Date.now();
const result = await runVibeTask({
  cwd,
  prompt: "Reply with exactly: OK",
  permission: "deny",
  timeoutMs: TIMEOUT_MS,
});

console.log("text:", JSON.stringify(result.text));
console.log("stopReason:", result.stopReason, "cancelled:", result.cancelled);
console.log("usage:", result.usage);
console.log("wall:", `${Date.now() - startedAt}ms`);

if (!result.text) fail("Vibe returned no assistant text");
if (result.stopReason !== "end_turn") fail(`stop reason ${result.stopReason}`);

// --- 3. turn 2/3: a tool call that is actually approved and executed ------
// The assertion is the command's own output, not the tool-call title: a denied
// or never-executed call still emits tool_call updates, but cannot print its output.
console.log("== turn 2/3: approved tool call ==");
const toolStartedAt = Date.now();
const toolRun = await runVibeTask({
  cwd,
  prompt: "Run the shell command `echo vibe-ok` and then reply with its output verbatim.",
  permission: "approve",
  timeoutMs: TIMEOUT_MS,
});

console.log("toolCalls:", toolRun.toolCalls);
console.log("text:", JSON.stringify(toolRun.text));
console.log("stopReason:", toolRun.stopReason, "wall:", `${Date.now() - toolStartedAt}ms`);

if (toolRun.toolCalls.length === 0) {
  fail("approve probe: Vibe never requested a tool call, so nothing was approved");
}
if (!/vibe-ok/.test(toolRun.text)) {
  fail("approve probe: the command output never reached the transcript, so the tool did not run");
}
if (toolRun.stopReason !== "end_turn") fail(`approve probe: stop reason ${toolRun.stopReason}`);

// --- 4. turn 3/3: cancel mid-turn, then leave nothing running -------------
console.log("== turn 3/3: mid-turn cancel ==");
const childrenBefore = childPids();
const controller = new AbortController();
let sawText = false;
let abortAt = 0;
// Abort as soon as the agent starts answering, so the cancel lands mid-turn
// rather than during startup. The fallback only covers an agent that stays
// silent: first-token latency is a few seconds, so a short timer would abort
// during startup every time and quietly test the wrong path.
const doAbort = (): void => {
  if (abortAt !== 0) return;
  abortAt = Date.now();
  controller.abort();
};
const fallback = setTimeout(doAbort, ABORT_FALLBACK_MS);
const cancelStartedAt = Date.now();
const cancelled = await runVibeTask({
  cwd,
  prompt: "Count from 1 to 50, one number per line, with a short sentence after each number.",
  permission: "deny",
  timeoutMs: TIMEOUT_MS,
  signal: controller.signal,
  onProgress: (progress) => {
    if (sawText || !progress.text) return;
    sawText = true;
    doAbort();
  },
});
clearTimeout(fallback);
const cancelElapsed = Date.now() - cancelStartedAt;
const ackMs = abortAt === 0 ? -1 : Date.now() - abortAt;

console.log(
  "stopReason:",
  cancelled.stopReason,
  "cancelled:",
  cancelled.cancelled,
  "wall:",
  `${cancelElapsed}ms`,
  "acknowledged in:",
  `${ackMs}ms`,
  "answered before abort:",
  sawText,
);
if (!cancelled.cancelled) fail("cancel probe: the run was not reported as cancelled");
if (cancelled.stopReason !== "cancelled") fail(`cancel probe: stop reason ${cancelled.stopReason}`);
if (abortAt === 0) fail("cancel probe: the abort was never sent");
if (ackMs > ABORT_GRACE_MS) {
  fail(`cancel probe: the abort took ${ackMs}ms to land, so it sat out the grace window`);
}
if (!sawText) {
  // Not fatal: the cancel still worked, it just landed during startup, which is
  // already covered offline. Say so, because this run then did not test a
  // mid-turn cancel.
  console.log("note: no assistant text arrived before the abort, so the cancel landed during startup");
}

const childrenAfter = await childrenAfterExit();
if (!childrenBefore || !childrenAfter) {
  console.log("orphan check skipped: pgrep unavailable");
} else {
  const leaked = childrenAfter.filter((pid) => !childrenBefore.includes(pid));
  if (leaked.length > 0) fail(`cancel probe left child process(es) running: ${leaked.join(", ")}`);
  console.log("orphan check: no child processes left running");
}

console.log("live smoke ok");
