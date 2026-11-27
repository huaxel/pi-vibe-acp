import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

export type FakeBehavior =
  | "normal"
  | "garbage"
  | "hang"
  | "exit-mid"
  | "slow"
  | "ask-fs"
  | "ask-always"
  | "ask-always-only"
  | "ask-permanent-only"
  | "ask-unknown-tool"
  | "modes-only"
  | "hang-init"
  | "ignore-cancel"
  | "usage-partial"
  | "config-stale"
  | "no-close";

export interface FakeAgent {
  /** Spawn spec: run the fake agent under the test runner's own node. */
  command: string;
  args: string[];
  /** Scratch working directory, also the fake session's cwd. */
  dir: string;
  /** Report written by the fake agent when it exits. */
  report: () => FakeReport;
  cleanup: () => void;
}

export interface FakeReport {
  behavior: string;
  methods: string[];
  initialize: {
    clientInfo?: { name?: string; version?: string };
    clientCapabilities?: Record<string, unknown>;
    protocolVersion?: number;
  } | null;
  newSession: { cwd?: string; mcpServers?: unknown[] } | null;
  configOptions: Array<{ configId: string; value: string }>;
  /** Mode ids received through the dedicated session/set_mode method. */
  modes: string[];
  permissionOutcomes: string[];
  cancelReceived: boolean;
  closeSession: boolean;
  unexpectedClientMethods: Array<{ method: string; error?: { code?: number } | null }>;
}

export function fakeAgent(behavior: FakeBehavior = "normal"): FakeAgent {
  const dir = mkdtempSync(join(tmpdir(), "pi-vibe-acp-"));
  const reportPath = join(dir, "report.json");
  return {
    command: process.execPath,
    args: [FAKE_AGENT, "--behavior", behavior, "--report", reportPath],
    dir,
    report: () => JSON.parse(readFileSync(reportPath, "utf8")) as FakeReport,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Poll a condition instead of sleeping: a fixed wait is the flake. */
export async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
