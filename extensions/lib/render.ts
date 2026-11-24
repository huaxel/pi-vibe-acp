import type { AcpUsage } from "./protocol.js";

/** Model-facing and renderer-facing details for one `vibe` tool call. */
export interface VibeToolDetails {
  complete: boolean;
  /** Assistant text received so far (final text once `complete`). */
  text?: string;
  sessionId?: string;
  stopReason?: string;
  cancelled?: boolean;
  usage?: AcpUsage;
  toolCalls: string[];
  applied: { mode?: string; model?: string; thinking?: string };
  thoughts?: number;
  durationMs?: number;
  truncated?: boolean;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1_000) return String(Math.round(count));
  if (count < 1_000_000) return `${trimZero(count / 1_000)}k`;
  return `${trimZero(count / 1_000_000)}M`;
}

export function formatUsage(usage: AcpUsage | undefined): string | undefined {
  if (!usage || !usage.totalTokens) return undefined;
  const parts = [`${formatTokens(usage.inputTokens)} in`, `${formatTokens(usage.outputTokens)} out`];
  if (usage.cachedReadTokens) parts.push(`${formatTokens(usage.cachedReadTokens)} cached`);
  return `${parts.join(" / ")} (${formatTokens(usage.totalTokens)} tokens)`;
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${trimZero(ms / 1_000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/** Single-line preview of a prompt or reply. */
export function previewText(text: string, limit = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Collapsed status line, e.g. `vibe 2 tools · 12.4k in / 34 out · 8.2s`. */
export function statusSummary(details: VibeToolDetails | undefined, isPartial: boolean): string {
  if (!details) return isPartial ? "starting…" : "done";
  const parts: string[] = [];
  if (details.applied?.model) parts.push(details.applied.model);
  if (details.toolCalls.length) {
    parts.push(`${details.toolCalls.length} tool${details.toolCalls.length === 1 ? "" : "s"}`);
  }
  const usage = formatUsage(details.usage);
  if (usage) parts.push(usage);
  const duration = formatDuration(details.durationMs);
  if (duration) parts.push(duration);
  if (details.stopReason && details.stopReason !== "end_turn") parts.push(details.stopReason);
  if (isPartial) return parts.length ? `${parts.join(" · ")} …` : "working…";
  return parts.join(" · ") || "done";
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
