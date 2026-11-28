import { contentText, getSystemMessageText, type Message, type SystemMessage } from "@earendil-works/pi-ai";

/**
 * Pi prompt sections that describe a harness Vibe is not running in.
 *
 * `tools` lists Pi's own tool set and `mcp_servers` the servers reachable through
 * Pi's `codemode`; `rules` are the rules for operating those tools ("always pass a
 * reasoning phrase to bash", "use codemode to batch calls"); `docs` points at Pi's
 * own documentation. None of it can be acted on here, and it buries the tools Vibe
 * actually has. `preamble`, `cwd`, `skills`, and `project_context` stay: they
 * describe the work, not Pi's tooling.
 */
const OMITTED_SECTIONS = new Set(["tools", "mcp_servers", "rules", "docs"]);

const RUNTIME_NOTE = [
  "<pi_acp_runtime>",
  "You are running as the model behind Pi's ACP provider, not inside Pi's own agent loop.",
  "Pi supplies the conversation and the project instructions only: it has no tools for you,",
  "so any Pi tool names, MCP servers, or tool-specific rules above do not apply.",
  "Do the work with Vibe's own tools in the working directory above, and put what matters in",
  "your reply: Pi displays your text, and Vibe's tool activity is not shown to the user.",
  "</pi_acp_runtime>",
].join("\n");

/**
 * The note when some work is delegated back to Pi.
 *
 * Saying "you have no tools" would be false: Pi advertises the handoff, so naming
 * which actions travel through it is what keeps the model from assuming a write
 * landed just because it asked for one.
 */
function delegatedRuntimeNote(delegated: readonly string[]): string {
  return [
    "<pi_acp_runtime>",
    "You are running as the model behind Pi's ACP provider, not inside Pi's own agent loop.",
    "Any Pi tool names, MCP servers, or tool-specific rules above still do not apply.",
    `Pi executes these actions for you, with its own approvals: ${delegated.join(", ")}.`,
    "Each one returns Pi's real result, so wait for it before assuming it happened.",
    "Everything else uses Vibe's own tools in the working directory above.",
    "Put what matters in your reply: Pi displays your text, and Vibe's tool activity is not shown.",
    "</pi_acp_runtime>",
  ].join("\n");
}

/**
 * Build the prompt Pi hands Vibe: the project instructions, minus Pi's tool inventory,
 * plus a note about the runtime Vibe is actually in.
 *
 * Vibe runs its own agent loop with its own tools, so a prompt advertising Pi's tools
 * (`read`, `bash`, `edit`, MCP servers, codemode) describes a harness the model is not
 * in. Everything else Pi contributes — AGENTS.md, skills, cwd, docs — still applies.
 */
export function buildVibeSystemPrompt(
  messages: readonly Message[],
  options: { delegated?: readonly string[] } = {},
): string {
  const note =
    options.delegated && options.delegated.length > 0
      ? delegatedRuntimeNote(options.delegated)
      : RUNTIME_NOTE;
  const replayed = replaySystemMessages(messages);
  if (!replayed) return note;

  const sections = Object.fromEntries(
    Object.entries(replayed.sections ?? {}).filter(
      ([name, value]) => value !== null && !OMITTED_SECTIONS.has(name),
    ),
  ) as Record<string, string>;

  const prompt = getSystemMessageText({ ...replayed, sections }).trim();
  return prompt ? `${prompt}\n\n${note}` : note;
}

/**
 * Replay every system message into one, as Pi does before a request: later `content`
 * is appended, `sections` are patched by name, and `null` removes one.
 */
function replaySystemMessages(messages: readonly Message[]): SystemMessage | undefined {
  const content: string[] = [];
  const sections = new Map<string, string | null>();
  let timestamp: number | undefined;

  for (const message of messages) {
    if (message.role !== "system") continue;
    timestamp ??= message.timestamp;
    const text = contentText(message.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      sections.set(name, value);
    }
  }

  if (timestamp === undefined) return undefined;
  return {
    role: "system",
    content: content.join("\n\n"),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    timestamp,
  };
}
