import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatDuration,
  formatUsage,
  previewText,
  statusSummary,
  type VibeToolDetails,
} from "./lib/render.js";
import {
  readVibeDoctor,
  runVibeTask,
  VIBE_PERMISSIONS,
  VibeAcpError,
  type VibeRunResult,
} from "./lib/vibe.js";

const DEFAULT_TIMEOUT_SECONDS = 900;

const vibeParameters = Type.Object({
  prompt: Type.String({
    description:
      "The task to hand to Vibe. Be self-contained: Vibe starts with no view of this conversation, " +
      "so state the goal, the files or directories involved, and what counts as done.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the Vibe session. Defaults to the current directory.",
    }),
  ),
  mode: Type.Optional(
    Type.String({
      description:
        "Vibe approval policy for the session: ask, accept-edits, smart-approve, or auto-approve. " +
        "Defaults to whatever Vibe has configured.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Vibe model alias (for example mistral-large-4-0 or zai-glm-5-3)." }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "Reasoning level: off, low, medium, high, xhigh, or max." }),
  ),
  permission: Type.Optional(
    StringEnum(VIBE_PERMISSIONS, {
      description:
        "How to answer Vibe's tool-permission requests: deny (default, read-only-ish tasks only), " +
        "ask (prompt for each request; requires an interactive session), or approve (allow every request).",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: `Turn timeout in seconds (5-3600, default ${DEFAULT_TIMEOUT_SECONDS}).`,
      minimum: 5,
      maximum: 3600,
    }),
  ),
});

type VibeParams = {
  prompt: string;
  cwd?: string;
  mode?: string;
  model?: string;
  thinking?: string;
  permission?: (typeof VIBE_PERMISSIONS)[number];
  timeoutSeconds?: number;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "vibe",
    label: "Mistral Vibe",
    description:
      "Delegate a self-contained coding task to Mistral Vibe's own agent over ACP (vibe-acp). " +
      "Vibe runs its own tool loop in the given directory and this returns its final message plus token counts. " +
      "Model usage is Vibe's, not this session's.",
    promptSnippet:
      "Hand a self-contained task to Mistral Vibe's agent (ACP), which runs in its own tool loop",
    promptGuidelines: [
      "Use vibe when the user asks for Mistral Vibe specifically, or when a task should run in Vibe's own agent loop instead of this session's tools.",
      "Give vibe a self-contained prompt: it cannot see this conversation, and it edits the working tree itself.",
      "Set vibe's permission to \"approve\" only when the task needs writes or commands; the default denies Vibe's tool requests and suits read-only investigation.",
      "Read vibe's token counts from its details, not as this session's usage; those tokens are billed to Vibe.",
    ],
    parameters: vibeParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as VibeParams;
      const cwd = resolveCwd(input.cwd, ctx.cwd);
      const permission = input.permission ?? "deny";
      const timeoutSeconds = clampSeconds(input.timeoutSeconds);

      const base: VibeToolDetails = {
        complete: false,
        text: "",
        toolCalls: [],
        applied: {},
      };

      if (permission === "ask" && !ctx.hasUI) {
        throw new Error(
          'vibe: permission "ask" needs an interactive session; use "deny" or "approve" instead.',
        );
      }

      let result: VibeRunResult;
      try {
        result = await runVibeTask({
          cwd,
          prompt: input.prompt,
          mode: input.mode,
          model: input.model,
          thinking: input.thinking,
          permission,
          timeoutMs: timeoutSeconds * 1_000,
          command: process.env.VIBE_ACP_BIN,
          clientName: process.env.PI_VIBE_ACP_CLIENT_NAME ?? "pi",
          signal,
          onProgress: (progress) => {
            onUpdate?.({
              content: [
                { type: "text", text: progress.text || "Vibe is working…" },
              ],
              details: {
                ...base,
                text: progress.text,
                toolCalls: progress.toolCalls,
                usage: progress.usage,
              },
            });
          },
          confirm:
            permission === "ask" && ctx.hasUI
              ? async ({ title, message }) => ctx.ui.confirm(title, message)
              : undefined,
        });
      } catch (error) {
        if (error instanceof VibeAcpError) throw new Error(error.message);
        throw error;
      }

      const details: VibeToolDetails = {
        complete: true,
        text: result.text,
        sessionId: result.sessionId,
        stopReason: result.stopReason,
        cancelled: result.cancelled,
        usage: result.usage,
        toolCalls: result.toolCalls,
        applied: result.applied,
        thoughts: result.thoughts,
        durationMs: result.durationMs,
        truncated: result.truncated,
      };

      return {
        content: [{ type: "text", text: modelFacingText(result) }],
        details,
      };
    },

    renderCall(args, theme) {
      const input = args as VibeParams;
      let line = theme.fg("toolTitle", theme.bold("vibe "));
      line += theme.fg("dim", previewText(input.prompt ?? "", 64));
      if (input.cwd) line += theme.fg("muted", ` in ${input.cwd}`);
      const hints = [input.model, input.mode, input.permission].filter(Boolean);
      if (hints.length) line += theme.fg("muted", ` (${hints.join(", ")})`);
      return new Text(line, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as VibeToolDetails | undefined;
      const error = (result as { isError?: boolean }).isError === true;

      if (isPartial) {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(theme.fg("warning", statusSummary(details, true)));
        return text;
      }

      const lines: string[] = [];
      const status = statusSummary(details, false);
      lines.push(theme.fg(error ? "error" : "success", `${error ? "✗" : "✓"} ${status}`));

      if (details?.toolCalls.length) {
        const shown = expanded ? details.toolCalls : details.toolCalls.slice(0, 3);
        for (const title of shown) lines.push(theme.fg("dim", `  · ${previewText(title, 100)}`));
        if (shown.length < details.toolCalls.length) {
          lines.push(theme.fg("dim", `  · +${details.toolCalls.length - shown.length} more`));
        }
      }

      const text = details?.text ?? "";
      if (text) {
        const limit = expanded ? 4_000 : 400;
        const body = text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
        lines.push(theme.fg("toolOutput", body));
      }
      if (details?.truncated) lines.push(theme.fg("warning", "(output truncated at 60k characters)"));
      if (details?.cancelled) lines.push(theme.fg("warning", "(cancelled)"));

      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerCommand("vibe", {
    description: "Report the Mistral Vibe ACP agent's version, auth methods, and session options",
    handler: async (_args, ctx) => {
      try {
        const doctor = await readVibeDoctor({
          cwd: ctx.cwd,
          command: process.env.VIBE_ACP_BIN,
          clientName: process.env.PI_VIBE_ACP_CLIENT_NAME ?? "pi",
        });
        const lines = [
          `agent: ${doctor.agent?.name ?? "unknown"} ${doctor.agent?.version ?? ""}`.trim(),
          `protocol: v${doctor.protocolVersion}`,
          `auth: ${doctor.authMethods.length ? doctor.authMethods.join(", ") : "none advertised"}`,
        ];
        for (const option of doctor.configOptions) {
          const values = option.options?.map((choice) => choice.value) ?? [];
          lines.push(
            `option ${option.id}: ${String(option.currentValue ?? "")}` +
              (values.length ? ` (${values.length} choices)` : ""),
          );
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`vibe: ${message}`, "error");
      }
    },
  });
}

/** Model-facing text: the reply, plus only the notes that change its meaning. */
export function modelFacingText(result: VibeRunResult): string {
  const notes: string[] = [];
  if (result.truncated) notes.push("output truncated at 60k characters");
  if (result.cancelled) notes.push("cancelled");
  else if (result.stopReason && result.stopReason !== "end_turn") {
    notes.push(`stopped: ${result.stopReason}`);
  }
  const usage = formatUsage(result.usage);
  const duration = formatDuration(result.durationMs);
  const applied = [result.applied.model, result.applied.mode, result.applied.thinking].filter(Boolean);
  const summary = [applied.join(" "), usage, duration].filter(Boolean).join(" · ");
  if (summary) notes.push(`vibe: ${summary}`);

  const body = result.text.trim();
  if (!body) {
    return `Vibe returned no message text (${result.stopReason}).` + tail(notes);
  }
  return body + tail(notes);
}

function tail(notes: string[]): string {
  return notes.length ? `\n\n[${notes.join("; ")}]` : "";
}

function resolveCwd(requested: string | undefined, fallback: string): string {
  const raw = requested?.trim();
  if (!raw) return fallback;
  // Built-in tools accept a leading @; custom tools must strip it themselves.
  const cleaned = raw.startsWith("@") ? raw.slice(1) : raw;
  return resolve(fallback, cleaned);
}

function clampSeconds(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(3600, Math.max(5, Math.round(seconds)));
}
