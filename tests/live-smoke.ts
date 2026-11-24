/**
 * Live smoke test against the real `vibe-acp`.
 *
 * Spends a small amount of Vibe usage (one minimal turn), so it is not part of
 * `npm test`. Run it after installing Mistral Vibe:
 *
 *   npm run test:live
 */
import { readVibeDoctor, runVibeTask } from "../extensions/lib/vibe.js";

const cwd = process.cwd();

const doctor = await readVibeDoctor({ cwd });
console.log("agent:", doctor.agent);
console.log("protocol:", doctor.protocolVersion);
console.log("auth methods:", doctor.authMethods);
console.log(
  "options:",
  doctor.configOptions.map((option) => `${option.id}=${String(option.currentValue)}`),
);

const startedAt = Date.now();
const result = await runVibeTask({
  cwd,
  prompt: "Reply with exactly: OK",
  permission: "deny",
  timeoutMs: 180_000,
});

console.log("text:", JSON.stringify(result.text));
console.log("stopReason:", result.stopReason, "cancelled:", result.cancelled);
console.log("usage:", result.usage);
console.log("wall:", `${Date.now() - startedAt}ms`);

if (!result.text) throw new Error("live smoke failed: Vibe returned no assistant text");
if (result.stopReason !== "end_turn") {
  throw new Error(`live smoke failed: stop reason ${result.stopReason}`);
}
console.log("live smoke ok");
