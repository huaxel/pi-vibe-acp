import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";
import {
  formatDuration,
  formatTokens,
  formatUsage,
  previewText,
  statusSummary,
  type VibeToolDetails,
} from "../extensions/lib/render.js";

test("renders the Pi error flag and diagnostic when tool details are missing", () => {
  type Renderer = NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>;
  let render: Renderer | undefined;
  let registeredProviderId: string | undefined;
  const host: Pick<ExtensionAPI, "on" | "registerProvider" | "registerTool" | "registerCommand"> = {
    on: (() => () => undefined) as ExtensionAPI["on"],
    registerProvider: ((provider: { id?: string } | string) => {
      registeredProviderId = typeof provider === "string" ? provider : provider.id;
    }) as ExtensionAPI["registerProvider"],
    registerTool: (definition) => { render = definition.renderResult as Renderer | undefined; },
    registerCommand: () => undefined,
  };
  extension(host as ExtensionAPI);
  assert.equal(registeredProviderId, "vibe");
  assert.ok(render);
  const theme = { fg: (_color: string, value: string) => value } as Theme;
  const output = render(
    { content: [{ type: "text", text: "vibe-acp is not installed" }], details: undefined },
    { expanded: false, isPartial: false },
    theme,
    { isError: true } as Parameters<typeof render>[3],
  ).render(80).map((line) => line.trimEnd());
  assert.deepEqual(output, ["✗ failed", "vibe-acp is not installed"]);
});

test("formatTokens keeps small counts exact and abbreviates large ones", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(842), "842");
  assert.equal(formatTokens(1_000), "1k");
  assert.equal(formatTokens(12_400), "12.4k");
  assert.equal(formatTokens(1_500_000), "1.5M");
});

test("formatUsage skips empty usage and mentions cache reads", () => {
  assert.equal(formatUsage(undefined), undefined);
  assert.equal(formatUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), undefined);
  assert.equal(
    formatUsage({ inputTokens: 1200, outputTokens: 34, totalTokens: 1234 }),
    "1.2k in / 34 out (1.2k tokens)",
  );
  assert.equal(
    formatUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: 8 }),
    "10 in / 2 out / 8 cached (12 tokens)",
  );
});

test("formatDuration renders sub-second, seconds, and minutes", () => {
  assert.equal(formatDuration(480), "480ms");
  assert.equal(formatDuration(8_200), "8.2s");
  assert.equal(formatDuration(125_000), "2m05s");
  assert.equal(formatDuration(undefined), undefined);
});

test("previewText flattens whitespace and truncates with an ellipsis", () => {
  assert.equal(previewText("  hello   world \n"), "hello world");
  const long = "x".repeat(200);
  const preview = previewText(long, 20);
  assert.equal(preview.length, 20);
  assert.ok(preview.endsWith("…"));
});

test("statusSummary reports model, tools, tokens, and the stop reason", () => {
  const details: VibeToolDetails = {
    complete: true,
    toolCalls: ["bash: ls", "read: a.ts"],
    applied: { model: "mistral-large-4-0" },
    usage: { inputTokens: 1200, outputTokens: 34, totalTokens: 1234 },
    durationMs: 8_200,
    stopReason: "end_turn",
  };
  assert.equal(
    statusSummary(details, false),
    "mistral-large-4-0 · 2 tools · 1.2k in / 34 out (1.2k tokens) · 8.2s",
  );

  assert.equal(statusSummary({ ...details, stopReason: "max_tokens" }, false).includes("max_tokens"), true);
  assert.equal(statusSummary(undefined, true), "starting…");
  assert.equal(statusSummary(undefined, false), "done");
});
