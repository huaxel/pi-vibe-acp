import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runVibeTask, readVibeDoctor, stripAnsi, VibeAcpError } from "../extensions/lib/vibe.js";
import { modelFacingText } from "../extensions/index.js";
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
  // The claim in README/CHANGELOG that Vibe cannot borrow Pi's authority rests on
  // this staying empty: no filesystem, terminal, elicitation, or MCP capabilities.
  assert.deepEqual(report.initialize?.clientCapabilities, {});
  assert.equal(report.newSession?.cwd, agent.dir);
  assert.deepEqual(report.configOptions, [
    { configId: "mode", value: "auto-approve" },
    { configId: "model", value: "fake-two" },
    { configId: "thinking", value: "high" },
  ]);
  // Mode went through the config option this agent advertises, so the dedicated
  // session method must not have been used.
  assert.deepEqual(report.modes, []);
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

test("a missing cwd is reported as a missing cwd, not a missing binary", async () => {
  await assert.rejects(
    runVibeTask({
      cwd: join(process.cwd(), "definitely-not-a-real-directory"),
      prompt: "anything",
      // Keep the guard honest: if validation regressed, this test must not start
      // whatever real vibe-acp happens to be on PATH.
      command: "/nonexistent/definitely-not-vibe-acp",
    }),
    (error: unknown) => {
      assert.ok(error instanceof VibeAcpError);
      assert.match(error.message, /working directory .* does not exist/);
      assert.doesNotMatch(error.message, /not installed|install Mistral Vibe/);
      return true;
    },
  );
});

test("a startup failure is translated instead of leaking the raw error", async () => {
  const agent = fakeAgent("normal");
  await assert.rejects(
    runVibeTask({
      cwd: agent.dir,
      prompt: "anything",
      command: agent.command,
      // spawn() throws synchronously on a bad args type; that must not escape
      // runVibeTask as a bare TypeError.
      args: 42 as unknown as string[],
    }),
    (error: unknown) => {
      assert.ok(error instanceof VibeAcpError, `expected VibeAcpError, got ${String(error)}`);
      return true;
    },
  );
  agent.cleanup();
});

test("prefers the once-only grant when the agent offers several", async () => {
  const agent = fakeAgent("ask-always");
  const prompts: string[] = [];

  await runVibeTask({
    cwd: agent.dir,
    prompt: "edit something",
    ...spawnSpec(agent),
    permission: "ask",
    confirm: async ({ message }) => {
      prompts.push(message);
      return true;
    },
  });

  assert.equal(agent.report().permissionOutcomes[0], "selected:allow_once");
  assert.match(prompts[0] ?? "", /Approve once\?/);
  agent.cleanup();
});

test("names a session-wide grant when that is all the agent offers", async () => {
  const agent = fakeAgent("ask-always-only");
  const prompts: string[] = [];

  await runVibeTask({
    cwd: agent.dir,
    prompt: "edit something",
    ...spawnSpec(agent),
    permission: "ask",
    confirm: async ({ message }) => {
      prompts.push(message);
      return true;
    },
  });

  assert.equal(agent.report().permissionOutcomes[0], "selected:allow_always");
  assert.match(prompts[0] ?? "", /for this session/);
  assert.doesNotMatch(prompts[0] ?? "", /Approve once\?/);
  agent.cleanup();
});

test("uses session/set_mode for agents that expose modes but no mode option", async () => {
  const agent = fakeAgent("modes-only");
  const result = await runVibeTask({
    cwd: agent.dir,
    prompt: "anything",
    ...spawnSpec(agent),
    mode: "auto-approve",
  });

  assert.deepEqual(result.applied, { mode: "auto-approve" });
  const report = agent.report();
  assert.deepEqual(report.modes, ["auto-approve"]);
  assert.deepEqual(report.configOptions, []);
  agent.cleanup();
});

test("names the available modes when a modes-only agent has no such mode", async () => {
  const agent = fakeAgent("modes-only");
  await assert.rejects(
    runVibeTask({ cwd: agent.dir, prompt: "anything", ...spawnSpec(agent), mode: "nonsense" }),
    (error: unknown) => {
      assert.ok(error instanceof VibeAcpError);
      assert.match(error.message, /vibe has no mode "nonsense"/);
      assert.match(error.message, /accept-edits/);
      return true;
    },
  );
  assert.deepEqual(agent.report().modes, []);
  agent.cleanup();
});

test("cancelling during startup reports a cancelled run, not a timeout", async () => {
  const agent = fakeAgent("hang-init");
  const controller = new AbortController();
  const startedAt = Date.now();
  const run = runVibeTask({
    cwd: agent.dir,
    prompt: "anything",
    ...spawnSpec(agent),
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 100);
  const result = await run;

  assert.equal(result.cancelled, true);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.text, "");
  // No cancel notification exists for initialize, so the default 5s grace window
  // must not apply: the abort lands at once and only teardown remains.
  assert.ok(Date.now() - startedAt < 2_000, "startup abort waited out a grace window");
  agent.cleanup();
});

test("an already-aborted signal reports a cancelled run without starting Vibe", async () => {
  const controller = new AbortController();
  controller.abort();
  const sentinel = join(process.cwd(), `.started-${process.pid}-${Date.now()}`);
  const result = await runVibeTask({
    cwd: process.cwd(),
    prompt: "anything",
    // If a process were spawned it would create the sentinel and fail here;
    // a cancelled run with no file proves the agent never started.
    command: "/bin/sh",
    args: ["-c", `: > ${sentinel}`],
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(existsSync(sentinel), false, "an aborted run started the agent anyway");
});

test("keeps usage reports that carry counts without a total", async () => {
  // Not a regression test: this pins the newest-report-wins reading of Vibe's
  // cumulative counts, so a later change cannot quietly start summing reports.
  const agent = fakeAgent("usage-partial");
  const result = await runVibeTask({
    cwd: agent.dir,
    prompt: "anything",
    ...spawnSpec(agent),
  });

  assert.deepEqual(result.usage, {
    inputTokens: 900,
    outputTokens: 100,
    totalTokens: 1_000,
    cachedReadTokens: 0,
  });
  agent.cleanup();
});

test("reports the option value the agent accepted, not the one requested", async () => {
  const agent = fakeAgent("config-stale");
  const result = await runVibeTask({
    cwd: agent.dir,
    prompt: "anything",
    ...spawnSpec(agent),
    model: "fake-two",
  });

  assert.deepEqual(result.applied, { model: "fake-one" });
  assert.deepEqual(result.adjusted, [
    { option: "model", requested: "fake-two", applied: "fake-one" },
  ]);
  assert.match(modelFacingText(result), /vibe kept model "fake-one" \(requested "fake-two"\)/);
  agent.cleanup();
});

test("does not close a session the agent never advertised closing", async () => {
  const agent = fakeAgent("no-close");
  const result = await runVibeTask({
    cwd: agent.dir,
    prompt: "anything",
    ...spawnSpec(agent),
  });

  assert.equal(result.stopReason, "end_turn");
  const report = agent.report();
  assert.equal(report.closeSession, false);
  assert.deepEqual(report.methods.filter((m) => m === "session/close"), []);
  agent.cleanup();
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
  assert.deepEqual(agent.report().initialize?.clientCapabilities, {});
  assert.deepEqual(doctor.authMethods, ["browser-auth"]);
  assert.equal(doctor.configOptions.find((option) => option.id === "model")?.currentValue, "fake-one");
  assert.deepEqual(agent.report().methods.filter((m) => m === "session/prompt"), []);
  agent.cleanup();
});

test("doctor explains a missing binary the same way a run does", async () => {
  await assert.rejects(
    readVibeDoctor({ cwd: process.cwd(), command: "/nonexistent/definitely-not-vibe-acp" }),
    (error: unknown) => {
      assert.ok(error instanceof VibeAcpError);
      assert.match(error.message, /uv tool install mistral-vibe/);
      return true;
    },
  );
});
