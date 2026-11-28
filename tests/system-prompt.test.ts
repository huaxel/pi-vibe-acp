import assert from "node:assert/strict";
import test from "node:test";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { buildVibeSystemPrompt } from "../extensions/lib/system-prompt.js";

function system(
  content: string,
  sections?: Record<string, string | null>,
  timestamp = 1,
): SystemMessage {
  return { role: "system", content, timestamp, ...(sections ? { sections } : {}) };
}

function user(content: string): Message {
  return { role: "user", content, timestamp: 2 };
}

test("drops Pi's tool and MCP sections while keeping project instructions", () => {
  const prompt = buildVibeSystemPrompt([
    system("You are a coding assistant running inside pi.", {
      preamble: "<preamble>Pi preamble</preamble>",
      tools: "<tools>\n- bash: Execute bash commands\n- agy_execute: delegate\n</tools>",
      rules: '<rules>\n- Always pass a "reasoning" phrase to bash\n</rules>',
      project_context: "<project_context>\nUse just ci\n</project_context>",
      mcp_servers: "<mcp_servers>\n- mcp__belgian_law (codemode)\n</mcp_servers>",
      cwd: "<cwd>/repo</cwd>",
    }),
    user("hello"),
  ]);

  assert.ok(prompt.includes("Pi preamble"), "keeps the preamble");
  assert.ok(prompt.includes("Use just ci"), "keeps AGENTS.md content");
  assert.ok(prompt.includes("<cwd>/repo</cwd>"), "keeps the working directory");
  assert.ok(!prompt.includes("- bash: Execute bash commands"), "drops Pi's tool list");
  assert.ok(!prompt.includes("mcp__belgian_law"), "drops Pi's MCP inventory");
  assert.ok(!prompt.includes("reasoning\" phrase to bash"), "drops Pi's tool rules");
  assert.ok(prompt.includes("<pi_acp_runtime>"), "states the actual runtime");
  assert.ok(prompt.includes("no tools for you"), "says Pi supplies no tools");
});

test("forwards only the sections a model in Vibe's harness can act on", () => {
  // The exact section names Pi sends, captured from a real request: preamble,
  // tools, rules, docs, skills, cwd, plus project_context when a directory has
  // AGENTS.md. Anything about Pi's own tooling is noise here.
  const prompt = buildVibeSystemPrompt([
    system("pi preamble", {
      preamble: "<preamble>pi preamble</preamble>",
      tools: "<tools>\n- bash: run commands\n</tools>",
      rules: "<rules>\n- pass a reasoning phrase\n</rules>",
      docs: "<docs>\n/path/to/pi/docs\n</docs>",
      skills: "<skills>\n- demo skill\n</skills>",
      cwd: "<cwd>/repo</cwd>",
      project_context: "<project_context>\nUse just ci\n</project_context>",
    }),
    user("go"),
  ]);

  for (const kept of ["pi preamble", "demo skill", "/repo", "Use just ci", "<pi_acp_runtime>"]) {
    assert.ok(prompt.includes(kept), `keeps ${kept}`);
  }
  for (const dropped of ["- bash: run commands", "pass a reasoning phrase", "/path/to/pi/docs"]) {
    assert.ok(!prompt.includes(dropped), `drops ${dropped}`);
  }
});

test("replays later system messages: sections patch by name and null removes one", () => {
  const prompt = buildVibeSystemPrompt([
    system("base", {
      tools: "<tools>\n- read\n</tools>",
      project_context: "<project_context>old</project_context>",
      docs: "<docs>Pi docs</docs>",
    }),
    system("", { project_context: "<project_context>new</project_context>", docs: null }),
    user("go on"),
  ]);

  assert.ok(prompt.includes("new"), "uses the patched section");
  assert.ok(!prompt.includes(">old<"), "replaces the older section");
  assert.ok(!prompt.includes("Pi docs"), "drops a section removed with null");
  assert.ok(!prompt.includes("- read"), "still drops tool sections");
});

test("keeps appended system content in order before the sections", () => {
  const prompt = buildVibeSystemPrompt([
    system("first instruction", { skills: "<skills>use them</skills>" }),
    system("second instruction"),
    user("hi"),
  ]);

  assert.ok(
    prompt.indexOf("first instruction") < prompt.indexOf("second instruction"),
    "appends later content",
  );
  assert.ok(prompt.indexOf("second instruction") < prompt.indexOf("<skills>"), "content precedes sections");
});

test("returns only the runtime note when the transcript has no system message", () => {
  const prompt = buildVibeSystemPrompt([user("hi")]);
  assert.equal(prompt.split("\n")[0], "<pi_acp_runtime>");
  assert.ok(!prompt.includes("undefined"));
});

test("never leaks tool declarations carried outside the prompt text", () => {
  const message: SystemMessage = {
    role: "system",
    content: "",
    sections: { cwd: "<cwd>/repo</cwd>" },
    toolsAdded: [{ name: "bash", description: "Pi bash", parameters: { type: "object" } }],
    timestamp: 1,
  };
  const prompt = buildVibeSystemPrompt([message, user("hi")]);
  assert.ok(!prompt.includes("Pi bash"));
  assert.ok(prompt.includes("<cwd>/repo</cwd>"));
});

test("names the delegated tools instead of claiming Vibe has none", () => {
  const prompt = buildVibeSystemPrompt([system("Stay brief."), user("go")], {
    delegated: ["write", "bash"],
  });
  assert.match(prompt, /Pi executes these actions for you, with its own approvals: write, bash\./);
  assert.match(prompt, /Each one returns Pi's real result/);
  // The no-tools claim would be false once the handoff is advertised.
  assert.doesNotMatch(prompt, /it has no tools for you/);
});

test("keeps the no-tools note when nothing is delegated", () => {
  const prompt = buildVibeSystemPrompt([system("Stay brief."), user("go")]);
  assert.match(prompt, /it has no tools for you/);
  assert.doesNotMatch(prompt, /Pi executes these actions for you/);
});
