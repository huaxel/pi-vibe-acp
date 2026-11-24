import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { AcpClient, AcpTimeoutError } from "../extensions/lib/acp-client.js";
import { fakeAgent, waitFor } from "./helpers.js";

function refusalMarker(agent: ReturnType<typeof fakeAgent>): string {
  const reportPath = agent.args[agent.args.indexOf("--report") + 1];
  return `${reportPath}.refused`;
}

function connect(agent: ReturnType<typeof fakeAgent>, overrides: Partial<ConstructorParameters<typeof AcpClient>[0]> = {}) {
  return new AcpClient({
    command: agent.command,
    args: agent.args,
    cwd: agent.dir,
    requestTimeoutMs: 5_000,
    ...overrides,
  });
}

test("survives unusable stdout lines and still answers", async () => {
  const agent = fakeAgent("garbage");
  const client = connect(agent, {
    onPermissionRequest: () => ({ outcome: "cancelled" }),
  });
  try {
    const init = await client.initialize({ name: "pi", version: "test" });
    assert.equal(init.agentInfo?.version, "3.1.4-fake");

    const session = await client.newSession(agent.dir);
    const prompt = await client.prompt(session.sessionId, "hello");
    assert.equal(prompt.stopReason, "end_turn");
    assert.equal(prompt.usage?.totalTokens, 1234);
  } finally {
    await client.dispose();
  }

  assert.equal(agent.report().behavior, "garbage");
  agent.cleanup();
});

test("times out with the method name instead of hanging", async () => {
  const agent = fakeAgent("hang");
  const client = connect(agent, { requestTimeoutMs: 300 });
  try {
    const session = await client.newSession(agent.dir);
    await assert.rejects(
      client.prompt(session.sessionId, "never answered"),
      (error: unknown) => {
        assert.ok(error instanceof AcpTimeoutError);
        assert.match(error.message, /session\/prompt did not answer within/);
        return true;
      },
    );
  } finally {
    await client.dispose();
  }
  agent.cleanup();
});

test("rejects in-flight requests when the agent dies, keeping stderr", async () => {
  const agent = fakeAgent("exit-mid");
  const client = connect(agent);
  try {
    const session = await client.newSession(agent.dir);
    await assert.rejects(client.prompt(session.sessionId, "boom"), (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /agent exited before answering/);
      assert.match(message, /fake agent exploded/);
      return true;
    });
  } finally {
    await client.dispose();
  }
  agent.cleanup();
});

test("refuses client methods it never advertised", async () => {
  const agent = fakeAgent("ask-fs");
  const client = connect(agent);
  try {
    await client.initialize({ name: "pi", version: "test" });
    // The agent asks for a method this client never advertised; wait for its
    // record of the refusal rather than racing the teardown.
    await waitFor(
      () => existsSync(`${new URL(".", import.meta.url).pathname}`) && existsSync(refusalMarker(agent)),
      "the agent to record the refused client method",
    );
  } finally {
    await client.dispose();
  }

  const report = agent.report();
  assert.equal(report.unexpectedClientMethods.length, 1);
  assert.equal(report.unexpectedClientMethods[0].method, "fs/read_text_file");
  assert.equal(report.unexpectedClientMethods[0].error?.code, -32601);
  agent.cleanup();
});

test("dispose terminates an agent that never answers", async () => {
  const agent = fakeAgent("hang");
  const client = connect(agent);
  const startedAt = Date.now();
  await client.dispose();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 10_000, `dispose took ${elapsed}ms`);
  await assert.rejects(client.request("initialize", {}), /connection is closed/);
  agent.cleanup();
});

test("a request after dispose fails instead of writing to a dead pipe", async () => {
  const agent = fakeAgent("normal");
  const client = connect(agent);
  await client.dispose();
  await assert.rejects(client.request("session/new", {}), /connection is closed/);
  agent.cleanup();
});
