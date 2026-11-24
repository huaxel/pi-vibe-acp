import assert from "node:assert/strict";
import { test } from "node:test";
import { runVibeTask, readVibeDoctor, stripAnsi, VibeAcpError } from "../extensions/lib/vibe.js";
import { fakeAgent, type FakeAgent } from "./helpers.js";

function spawnSpec(agent: FakeAgent) {
  return { command: agent.command, args: agent.args };
}

test("runs a turn, applies requested options, and reports Vibe's tokens", async () => {
  const agent = fakeAgent("normal");
  const progress: string[] = [];

  const result = await runVibeTask({
    cwd: agent.dir,
    prompt: "list the directory",
    ...spawnSpec(agent),
    permission: "approve",
    mode: "auto-approve",
    model: "fake-two",
    thinking: "high",
    onProgress: (snapshot) => progress.push(snapshot.text),
  });

  assert.equal(result.text, "Hello world");
  assert.deepEqual(result.toolCalls, ["bash: ls -la"]);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.cancelled, false);
  assert.equal(result.usage?.totalTokens, 1234);
  assert.equal(result.usage?.inputTokens, 1200);
  assert.deepEqual(result.applied, {
    mode: "auto-approve",
    model: "fake-two",
    thinking: "high",
  });
  assert.equal(result.agent?.version, "3.1.4-fake");
  assert.ok(progress.length >= 1, "streamed at least one progress update");

  const report = agent.report();
  assert.equal(report.initialize?.clientInfo?.name, "pi");
  assert.equal(report.newSession?.cwd, agent.dir);
  assert.deepEqual(report.configOptions, [
    { configId: "mode", value: "auto-approve" },
    { configId: "model", value: "fake-two" },
    { configId: "thinking", value: "high" },
  ]);
  assert.equal(report.permissionOutcomes[0], "selected:allow_once");
  assert.equal(report.closeSession, true);

  agent.cleanup();
});

test("denies permission requests by default without failing the turn", async () => {
  const agent = fakeAgent("normal");
  const result = await runVibeTask({
    cwd: agent.dir,
    prompt: "read only",
    ...spawnSpec(agent),
  });

  assert.equal(result.text, "Hello world");
  assert.equal(agent.report().permissionOutcomes[0], "cancelled");
  agent.cleanup();
});

test("asks the host when permission is 'ask' and honours the answer", async () => {
  const agent = fakeAgent("normal");
  const answers = [false, true];
  const prompts: string[] = [];

  const first = await runVibeTask({
    cwd: agent.dir,
    prompt: "edit something",
    ...spawnSpec(agent),
    permission: "ask",
    confirm: async ({ title, message }) => {
      prompts.push(`${title}: ${message}`);
      return answers.shift() ?? false;
    },
  });
  assert.equal(first.text, "Hello world");
  assert.equal(agent.report().permissionOutcomes[0], "cancelled");
  assert.match(prompts[0] ?? "", /Vibe wants to act: bash: ls -la/);

  const secondAgent = fakeAgent("normal");
  await runVibeTask({
    cwd: secondAgent.dir,
    prompt: "edit something",
    ...spawnSpec(secondAgent),
    permission: "ask",
    confirm: async () => true,
  });
  assert.equal(secondAgent.report().permissionOutcomes[0], "selected:allow_once");

  agent.cleanup();
  secondAgent.cleanup();
});

test("refuses a model or mode Vibe does not offer, naming the alternatives", async () => {
  const agent = fakeAgent("normal");
  await assert.rejects(
    runVibeTask({
      cwd: agent.dir,
      prompt: "anything",
      ...spawnSpec(agent),
      mode: "nonsense",
    }),
    (error: unknown) => {
      assert.ok(error instanceof VibeAcpError);
      assert.match(error.message, /vibe has no mode "nonsense"/);
      assert.match(error.message, /accept-edits/);
      return true;
    },
  );
  agent.cleanup();
});

test("aborting cancels the turn cleanly and reports it", async () => {
  const agent = fakeAgent("slow");
  const controller = new AbortController();
  const run = runVibeTask({
    cwd: agent.dir,
    prompt: "long task",
    ...spawnSpec(agent),
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 150);
  const result = await run;

  assert.equal(result.cancelled, true);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.usage?.totalTokens, 13);
  assert.equal(agent.report().cancelReceived, true);
  agent.cleanup();
});

test("a turn timeout explains that Vibe may still be running", async () => {
  const agent = fakeAgent("hang");
  await assert.rejects(
    runVibeTask({
      cwd: agent.dir,
      prompt: "never finishes",
      ...spawnSpec(agent),
      timeoutMs: 300,
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /did not answer within 300ms/);
      assert.match((error as Error).message, /keeps running inside Vibe/);
      return true;
    },
  );
  agent.cleanup();
});

test("a missing binary says how to install Vibe", async () => {
  await assert.rejects(
    runVibeTask({
      cwd: process.cwd(),
      prompt: "anything",
      command: "/nonexistent/definitely-not-vibe-acp",
    }),
    (error: unknown) => {
      assert.ok(error instanceof VibeAcpError);
      assert.match(error.message, /not installed or not on PATH/);
      assert.match(error.message, /uv tool install mistral-vibe/);
      return true;
    },
  );
});

test("strips terminal escapes so the transcript stays readable", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m and \u001b]0;title\u0007plain"), "red and plain");
  assert.equal(stripAnsi("bell\u0007 and null\u0000").replace(/\s+/g, " ").trim(), "bell and null");
});

test("doctor reports identity, auth methods, and session options without prompting", async () => {
  const agent = fakeAgent("normal");
  const doctor = await readVibeDoctor({ cwd: agent.dir, ...spawnSpec(agent) });

  assert.equal(doctor.agent?.version, "3.1.4-fake");
  assert.equal(doctor.protocolVersion, 1);
  assert.deepEqual(doctor.authMethods, ["browser-auth"]);
  assert.equal(doctor.configOptions.find((option) => option.id === "model")?.currentValue, "fake-one");
  assert.deepEqual(agent.report().methods.filter((m) => m === "session/prompt"), []);
  agent.cleanup();
});
