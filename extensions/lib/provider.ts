import {
  createAssistantMessageEventStream,
  createProvider,
  getCurrentSystemPrompt,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthContext,
  type Model,
  type Provider,
  type ProviderEnv,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  discoverVibeModels,
  isVibeAcpAvailable,
  VIBE_API_ID,
  VIBE_BASE_URL,
  VIBE_FALLBACK_MODELS,
  VIBE_PROVIDER_ID,
  type VibeModel,
} from "./provider-models.js";
import { VibeSessionPool } from "./provider-session.js";
import { previewText } from "./render.js";
import { VIBE_PERMISSIONS, type VibePermission } from "./vibe.js";

const PROVIDER_ENV_NAMES = [
  "VIBE_ACP_BIN",
  "PI_VIBE_ACP_CLIENT_NAME",
  "PI_VIBE_ACP_MODE",
  "PI_VIBE_ACP_PERMISSION",
] as const;

export interface VibeProviderRuntimeSettings {
  mode?: string;
  permission?: VibePermission;
}

export interface VibeProviderUiBridge {
  hasUI: () => boolean;
  confirm?: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
  setStatus?: (key: string, text: string | undefined) => void;
}

export interface CreateVibeProviderOptions {
  pool: VibeSessionPool;
  getCwd: () => string;
  getSettings: () => VibeProviderRuntimeSettings;
  ui?: VibeProviderUiBridge;
  /** Override for tests. */
  discoverModels?: typeof discoverVibeModels;
  /** Override for tests. */
  checkAvailable?: typeof isVibeAcpAvailable;
  /** Extra args passed to the ACP binary (used by tests with fake-agent). */
  args?: string[];
  abortGraceMs?: number;
}

async function readProviderEnv(ctx: AuthContext): Promise<ProviderEnv | undefined> {
  const env: ProviderEnv = {};
  await Promise.all(
    PROVIDER_ENV_NAMES.map(async (name) => {
      const value = await ctx.env(name);
      if (value !== undefined) env[name] = value;
    }),
  );
  return Object.keys(env).length ? env : undefined;
}

function parsePermissionEnv(raw: string | undefined): VibePermission | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim() as VibePermission;
  return VIBE_PERMISSIONS.includes(trimmed) ? trimmed : undefined;
}

function resolveThinkingLevel(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): string | undefined {
  const reasoning = options?.reasoning;
  // No explicit level means Pi did not pick one: leave Vibe's own thinking
  // setting alone rather than overwriting a preference the user set in the CLI.
  if (!reasoning) return undefined;
  const mapped = model.thinkingLevelMap?.[reasoning];
  // `null` marks a level this model does not offer, so there is nothing to send.
  if (mapped === null) return undefined;
  if (typeof mapped === "string" && mapped) return mapped;
  return reasoning;
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createVibeProvider(deps: CreateVibeProviderOptions): Provider<typeof VIBE_API_ID> {
  let lastProviderEnv: ProviderEnv | undefined;
  let discoveredIds: Set<string> | undefined;

  const mergedEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...lastProviderEnv });
  const discover = deps.discoverModels ?? discoverVibeModels;
  const checkAvailable = deps.checkAvailable ?? isVibeAcpAvailable;

  function streamVibe(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };

      const dialogLifetime = new AbortController();
      const signal = options?.signal;
      const dialogSignal = signal
        ? AbortSignal.any([signal, dialogLifetime.signal])
        : dialogLifetime.signal;

      const setStatus = (label: string | undefined) => {
        deps.ui?.setStatus?.(VIBE_PROVIDER_ID, label);
      };

      let thinkingIndex = -1;
      let textIndex = -1;

      const ensureThinking = (): number => {
        if (thinkingIndex !== -1) return thinkingIndex;
        thinkingIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
        return thinkingIndex;
      };

      const closeThinking = (): void => {
        if (thinkingIndex === -1) return;
        const block = output.content[thinkingIndex] as { type: "thinking"; thinking: string };
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingIndex,
          content: block.thinking,
          partial: output,
        });
        thinkingIndex = -1;
      };

      const ensureText = (): number => {
        if (textIndex !== -1) return textIndex;
        closeThinking();
        textIndex = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
        return textIndex;
      };

      try {
        stream.push({ type: "start", partial: output });

        const env = mergedEnv();
        const settings = deps.getSettings();
        const hasUI = deps.ui?.hasUI() ?? false;
        const configuredPermission = settings.permission ?? parsePermissionEnv(env.PI_VIBE_ACP_PERMISSION);
        const permission: VibePermission = configuredPermission ?? (hasUI ? "ask" : "deny");
        const mode = settings.mode ?? (env.PI_VIBE_ACP_MODE?.trim() || undefined);
        const thinking = resolveThinkingLevel(model, options);
        const systemPrompt = getCurrentSystemPrompt(context.messages);

        const result = await deps.pool.runTurn({
          cwd: deps.getCwd(),
          messages: context.messages,
          systemPrompt,
          model: model.id,
          thinking,
          mode,
          permission: permission === "ask" && !hasUI ? "deny" : permission,
          command: env.VIBE_ACP_BIN,
          args: deps.args,
          env,
          clientName: env.PI_VIBE_ACP_CLIENT_NAME ?? "pi",
          signal,
          abortGraceMs: deps.abortGraceMs,
          confirm:
            permission === "ask" && hasUI && deps.ui?.confirm
              ? ({ title, message }) => deps.ui!.confirm!(title, message, { signal: dialogSignal })
              : undefined,
          onThinkingDelta: (delta) => {
            const idx = ensureThinking();
            const block = output.content[idx] as { type: "thinking"; thinking: string };
            block.thinking += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: idx,
              delta,
              partial: output,
            });
          },
          onTextDelta: (delta) => {
            const idx = ensureText();
            const block = output.content[idx] as { type: "text"; text: string };
            block.text += delta;
            stream.push({
              type: "text_delta",
              contentIndex: idx,
              delta,
              partial: output,
            });
          },
          onToolActivity: (title) => {
            setStatus(`vibe · ${previewText(title, 48)}`);
          },
        });

        setStatus(undefined);
        closeThinking();

        if (textIndex !== -1) {
          const block = output.content[textIndex] as { type: "text"; text: string };
          stream.push({
            type: "text_end",
            contentIndex: textIndex,
            content: block.text,
            partial: output,
          });
        } else if (!result.cancelled) {
          const idx = ensureText();
          const fallback = result.text || "(Vibe returned no text)";
          const block = output.content[idx] as { type: "text"; text: string };
          block.text = fallback;
          stream.push({ type: "text_delta", contentIndex: idx, delta: fallback, partial: output });
          stream.push({ type: "text_end", contentIndex: idx, content: fallback, partial: output });
        }

        if (result.usageDelta) {
          output.usage.input = result.usageDelta.inputTokens;
          output.usage.output = result.usageDelta.outputTokens;
          output.usage.cacheRead = result.usageDelta.cachedReadTokens ?? 0;
          output.usage.totalTokens = result.usageDelta.totalTokens;
        }

        if (result.cancelled) {
          output.stopReason = "aborted";
          output.errorMessage = "Request was aborted";
          stream.push({ type: "error", reason: "aborted", error: output });
          stream.end();
          return;
        }

        output.stopReason = result.stopReason === "max_tokens" ? "length" : "stop";
        result.commitSync(output);
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        setStatus(undefined);
        const aborted = Boolean(signal?.aborted);
        output.stopReason = aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      } finally {
        dialogLifetime.abort();
      }
    })();

    return stream;
  }

  return createProvider({
    id: VIBE_PROVIDER_ID,
    name: "Mistral Vibe (ACP)",
    baseUrl: VIBE_BASE_URL,
    auth: {
      apiKey: {
        name: "Mistral Vibe CLI",
        async check({ ctx }) {
          lastProviderEnv = await readProviderEnv(ctx);
          const env = mergedEnv();
          if (!checkAvailable(env.VIBE_ACP_BIN, env)) return undefined;
          return {
            type: "api_key",
            source: "Mistral Vibe CLI",
          };
        },
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          const providerEnv = await readProviderEnv(ctx);
          lastProviderEnv = providerEnv;
          return {
            auth: { apiKey: "external-process" },
            env: providerEnv,
            source: "Mistral Vibe CLI",
          };
        },
      },
    },
    models: VIBE_FALLBACK_MODELS,
    async fetchModels({ signal }) {
      const env = mergedEnv();
      const models: VibeModel[] = await discover({
        cwd: deps.getCwd(),
        command: env.VIBE_ACP_BIN,
        args: deps.args,
        env,
        clientName: env.PI_VIBE_ACP_CLIENT_NAME ?? "pi",
        signal,
      });
      if (models.length > 0) {
        discoveredIds = new Set(models.map((model) => model.id));
      }
      return models;
    },
    filterModels(models) {
      return discoveredIds ? models.filter((model) => discoveredIds!.has(model.id)) : models;
    },
    api: {
      stream: streamVibe,
      streamSimple: streamVibe,
    },
  });
}

export { VIBE_API_ID, VIBE_PROVIDER_ID };
