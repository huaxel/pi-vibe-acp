import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { AcpClient, resolveCommand } from "./acp-client.js";
import { supportsSessionClose, type AcpConfigOption } from "./protocol.js";
import { explainTurnError } from "./vibe.js";

export const VIBE_PROVIDER_ID = "vibe";
export const VIBE_API_ID = "vibe-acp";
export const VIBE_BASE_URL = "process://vibe-acp";

export type VibeModel = Model<typeof VIBE_API_ID>;

const ALL_PI_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const DEFAULT_CONTEXT_WINDOW = 256_000;
const DEFAULT_MAX_TOKENS = 32_000;

export interface DiscoveredVibeModel {
  id: string;
  name: string;
  description?: string;
  thinkingLevels: readonly string[];
  contextWindow?: number;
}

const FALLBACK_DISCOVERY: readonly DiscoveredVibeModel[] = [
  {
    id: "mistral-large-4-0",
    name: "Mistral Large 4",
    thinkingLevels: ["low", "medium", "high"],
  },
  {
    id: "mistral-medium-latest",
    name: "Mistral Medium",
    thinkingLevels: ["off", "high"],
  },
  {
    id: "zai-glm-5-3",
    name: "GLM 5.3",
    thinkingLevels: ["low", "high", "max"],
  },
  {
    id: "zai-glm-5-3-flash",
    name: "GLM 5.3 Flash",
    thinkingLevels: ["low", "high", "max"],
  },
  {
    id: "deepseek-v4-1-flash-1017",
    name: "DeepSeek V4.1 Flash",
    thinkingLevels: ["off", "low", "high", "max"],
  },
];

/**
 * Build a Pi `thinkingLevelMap` matching the exact thinking levels Vibe advertises.
 *
 * Pi's `getSupportedThinkingLevels` treats omitted `off`/`minimal`/`low`/`medium`/`high`
 * keys as supported unless explicitly mapped to `null`, so unsupported levels are marked
 * `null` to keep the picker honest.
 */
export function buildThinkingLevelMap(levels: readonly string[]): ThinkingLevelMap | undefined {
  const supported = new Set(levels);
  const hasReasoning = levels.some((level) => level !== "off");
  if (!hasReasoning) return undefined;

  const map: ThinkingLevelMap = {};
  for (const level of ALL_PI_THINKING_LEVELS) {
    map[level] = supported.has(level) ? level : null;
  }
  return map;
}

export function modelFromDiscovery(info: DiscoveredVibeModel): VibeModel {
  const thinkingLevelMap = buildThinkingLevelMap(info.thinkingLevels);
  return {
    id: info.id,
    name: info.name,
    api: VIBE_API_ID,
    provider: VIBE_PROVIDER_ID,
    baseUrl: VIBE_BASE_URL,
    reasoning: thinkingLevelMap !== undefined,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text"],
    // Billing belongs to Vibe's account/subscription rather than Pi's direct API meter.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

export const VIBE_FALLBACK_MODELS: readonly VibeModel[] = FALLBACK_DISCOVERY.map(modelFromDiscovery);

export interface DiscoverVibeModelsOptions {
  cwd: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  clientName?: string;
  clientVersion?: string;
  signal?: AbortSignal;
}

/**
 * Query the live `vibe-acp` binary for its model list and per-model thinking levels.
 *
 * Uses one short-lived ACP session and switches `model` in place to read each model's
 * advertised `thinking` options without spawning multiple processes.
 */
export async function discoverVibeModels(
  options: DiscoverVibeModelsOptions,
): Promise<VibeModel[]> {
  let client: AcpClient | undefined;
  let sessionId: string | undefined;
  let closeSupported = false;
  let authMethodCount = 0;

  try {
    client = new AcpClient({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    });
    const init = await client.initialize(
      {
        name: options.clientName ?? options.env?.PI_VIBE_ACP_CLIENT_NAME ?? "pi",
        title: "Pi",
        version: options.clientVersion ?? "unknown",
      },
      { signal: options.signal },
    );
    closeSupported = supportsSessionClose(init);
    authMethodCount = init.authMethods?.length ?? 0;

    const session = await client.newSession(options.cwd, { signal: options.signal });
    sessionId = session.sessionId;

    const initialOptions = session.configOptions ?? [];
    const modelOption = initialOptions.find((option) => option.id === "model");
    const choices = modelOption?.options ?? [];
    if (choices.length === 0) return [];

    const initialModelId = typeof modelOption?.currentValue === "string"
      ? modelOption.currentValue
      : undefined;
    const initialThinkingLevels = readThinkingLevels(initialOptions);

    const discovered: VibeModel[] = [];
    let switchedModel = false;
    for (const choice of choices) {
      let thinkingLevels: string[];
      if (choice.value === initialModelId) {
        thinkingLevels = initialThinkingLevels;
      } else {
        const updated = await client.setConfigOption(sessionId, "model", choice.value, {
          signal: options.signal,
        });
        switchedModel = true;
        thinkingLevels = readThinkingLevels(updated ?? []);
      }

      discovered.push(
        modelFromDiscovery({
          id: choice.value,
          name: choice.name || choice.value,
          description: choice.description ?? undefined,
          thinkingLevels,
        }),
      );
    }

    // Vibe persists model selection to ~/.vibe/config.toml; restore the user's
    // original model so discovery never silently changes their default.
    if (switchedModel && initialModelId) {
      await client.setConfigOption(sessionId, "model", initialModelId, {
        signal: options.signal,
      }).catch(() => undefined);
    }

    return discovered;
  } catch (error) {
    throw explainTurnError(error, authMethodCount);
  } finally {
    if (sessionId && closeSupported) {
      await client?.closeSession(sessionId).catch(() => undefined);
    }
    await client?.dispose();
  }
}

function readThinkingLevels(configOptions: readonly AcpConfigOption[]): string[] {
  const thinking = configOptions.find((option) => option.id === "thinking");
  return (thinking?.options ?? []).map((choice) => choice.value);
}

/**
 * Cheap executable check for `vibe-acp` (no subprocess spawn).
 *
 * Used by Pi's provider auth check so the `vibe` provider appears automatically when
 * `vibe-acp` is installed and stays hidden when it is not.
 */
export function isVibeAcpAvailable(
  command?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const bin = resolveCommand(command ?? env.VIBE_ACP_BIN);
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return isExecutable(bin);
  }

  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    if (isExecutable(join(dir, bin))) return true;
  }
  return false;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
