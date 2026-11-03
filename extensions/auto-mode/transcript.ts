import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  AGENT_ATTRIBUTION,
  agentMessageFromCustomEntry,
  agentMessageFromUserText,
  agentMessageFromWaitDetails,
  agentMessageLabel,
  backgroundJobResult,
  parentAgentId,
} from "./agent-messages.ts";
import {
  CHARS_PER_APPROX_TOKEN,
  DEFAULT_INCLUDE_PARENT_USER_MESSAGES,
  DEFAULT_INCLUDE_TOOL_RESULTS,
  DEFAULT_MAX_PARENT_USER_TRANSCRIPT_MESSAGES,
  DEFAULT_MAX_PARENT_USER_TRANSCRIPT_TOKENS,
  DEFAULT_MAX_TOOL_RESULT_TRANSCRIPT_ENTRIES,
  DEFAULT_MAX_TOOL_RESULT_TRANSCRIPT_TOKENS,
  DEFAULT_MAX_TOOL_TRANSCRIPT_CALLS,
  DEFAULT_MAX_USER_TRANSCRIPT_MESSAGES,
  READ_ONLY_TOOLS,
} from "./constants.ts";
import {
  exitCodeFromDetails,
  renderToolResult,
  summarizeToolCall,
  type ToolResultInput,
} from "./tool-results.ts";
import { findRootSessionEntries } from "./parent-session.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

const MAX_USER_ENTRY_TOKENS = 1000;
// The first user message is the brief: it defines the task and its bounds.
const MAX_BRIEF_ENTRY_TOKENS = 2000;
const MAX_ASK_ANSWER_ENTRY_TOKENS = 500;
const MAX_PINNED_ASK_ANSWERS = 8;
const MAX_TOOL_ENTRY_TOKENS = 1000;
const MAX_TOOL_RESULT_ENTRY_TOKENS = 400;
const USER_SPEAKER = "User";
const PARENT_USER_SPEAKER = "User (main session)";
const PARENT_USER_OPEN_TAG = "<parent-session-user-messages>";
const PARENT_USER_CLOSE_TAG = "</parent-session-user-messages>";
const OMITTED_ENTRIES_MARKER = "<transcript_entries_omitted />";
const BACKGROUND_JOB_TOOL = "background-job";
const UNKNOWN_TOOL = "unknown";

type TranscriptEntry = {
  index: number;
  order: number;
  kind: "user" | "tool" | "result";
  text: string;
  /** User-kind entries: the label before the colon, e.g. `User` or `Coordinator Main`. */
  speaker?: string;
  /** Kept whatever the message and token budgets say. */
  pinned?: boolean;
  /** The entry is a verified answer to an `ask` question. */
  ask?: boolean;
  /** Result-kind entries: rendered once the remaining budget is known. */
  result?: ToolResultInput;
};

export type ClassifierTranscriptBudgets = {
  maxUserTokens: number;
  maxToolTokens: number;
  /** Newest user, coordinator, and peer messages to keep. Pinned entries and the latest message always stay. */
  maxUserMessages?: number;
  maxToolCalls?: number;
  includeToolResults?: boolean;
  maxToolResultTokens?: number;
  maxToolResults?: number;
  /** Under an OMP subagent, add the root session's user messages as their own block. */
  includeParentUserMessages?: boolean;
  maxParentUserMessages?: number;
  maxParentUserTokens?: number;
};

/** Session entry holding user answers captured from OMP's built-in ask tool. */
export const ASK_ANSWER_ENTRY = "pi-automode-ask-answer";

export type AskAnswer = { question: string; answer: string };

type AskAnswerEntry = { toolCallId: string; answers: AskAnswer[] };

type AskQuestionResult = {
  question: string;
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
};

function isAskQuestionResult(value: unknown): value is AskQuestionResult {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "question" in value && typeof value.question === "string" &&
    "selectedOptions" in value && Array.isArray(value.selectedOptions) &&
    value.selectedOptions.every((option) => typeof option === "string") &&
    (!("customInput" in value) || value.customInput === undefined ||
      typeof value.customInput === "string") &&
    (!("note" in value) || value.note === undefined || typeof value.note === "string") &&
    (!("timedOut" in value) || value.timedOut === undefined ||
      typeof value.timedOut === "boolean");
}

function isAskAnswer(value: unknown): value is AskAnswer {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "question" in value && typeof value.question === "string" &&
    "answer" in value && typeof value.answer === "string";
}

function isAskAnswerEntry(value: unknown): value is AskAnswerEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "toolCallId" in value && typeof value.toolCallId === "string" &&
    value.toolCallId.length > 0 &&
    "answers" in value && Array.isArray(value.answers) && value.answers.length > 0 &&
    value.answers.every(isAskAnswer);
}

function askAnswer(result: unknown): AskAnswer[] {
  // OMP picks an option itself when an ask times out; that is not user consent.
  if (!isAskQuestionResult(result) || result.timedOut === true) return [];
  const parts: string[] = [];
  if (result.selectedOptions.length > 0) parts.push(result.selectedOptions.join(", "));
  if (result.customInput?.trim()) parts.push(`custom answer: ${result.customInput.trim()}`);
  if (result.note?.trim()) parts.push(`note: ${result.note.trim()}`);
  return parts.length > 0 ? [{ question: result.question, answer: parts.join("; ") }] : [];
}

/** Extract the answers a user gave in an OMP ask result's structured details. */
export function askAnswersFromDetails(details: unknown): AskAnswer[] {
  if (
    typeof details === "object" && details !== null && !Array.isArray(details) &&
    "results" in details && Array.isArray(details.results)
  ) {
    return details.results.flatMap(askAnswer);
  }
  return askAnswer(details);
}

function capturedAskAnswers(entries: SessionEntry[]): Map<string, AskAnswer[]> {
  const captured = new Map<string, AskAnswer[]>();
  for (const entry of entries) {
    if (
      entry.type === "custom" && entry.customType === ASK_ANSWER_ENTRY &&
      isAskAnswerEntry(entry.data)
    ) {
      captured.set(entry.data.toolCallId, entry.data.answers);
    }
  }
  return captured;
}

function flattenUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        !!block && typeof block === "object" && "type" in block,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

function collectAssistantToolCalls(content: unknown): Array<{
  id: string | undefined;
  name: string;
  input: unknown;
}> {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (
        block,
      ): block is {
        type: string;
        id?: unknown;
        name?: string;
        arguments?: unknown;
        input?: unknown;
      } => !!block && typeof block === "object" && "type" in block,
    )
    .filter((block) => block.type === "toolCall" || block.type === "tool_use")
    .map((block) => ({
      id: typeof block.id === "string" ? block.id : undefined,
      name: String(block.name ?? "tool"),
      input: "arguments" in block ? block.arguments : block.input,
    }));
}

export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_APPROX_TOKEN);
}

function truncateToTokenCap(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  if (approximateTokenCount(text) <= maxTokens) {
    return { text, truncated: false };
  }
  const maxCharacters = Math.max(1, maxTokens * CHARS_PER_APPROX_TOKEN);
  const omittedTokens = Math.max(
    1,
    approximateTokenCount(text) - maxTokens,
  );
  const marker = `<truncated approx_tokens="${omittedTokens}" />`;
  if (marker.length >= maxCharacters) {
    return { text: marker.slice(0, maxCharacters), truncated: true };
  }

  const retainedCharacters = maxCharacters - marker.length;
  const prefixCharacters = Math.ceil(retainedCharacters * 0.65);
  const suffixCharacters = retainedCharacters - prefixCharacters;
  return {
    text: `${text.slice(0, prefixCharacters)}${marker}${
      suffixCharacters > 0 ? text.slice(-suffixCharacters) : ""
    }`,
    truncated: true,
  };
}

/** The entries of one session that evidence is collected from. */
type EntrySource = {
  /** What the model sees: compaction-aware where the host provides it. */
  contextEntries: SessionEntry[];
  /** The whole active branch, which also holds the captured ask answers. */
  branchEntries: SessionEntry[];
};

type CollectOptions = {
  includeToolResults: boolean;
  /** Keep only what a person typed: human-attributed user messages and verified ask answers. */
  humanOnly?: boolean;
};

function sessionEntrySource(sessionManager: ExtensionContext["sessionManager"]): EntrySource {
  const manager = sessionManager as typeof sessionManager & {
    buildContextEntries?: () => SessionEntry[];
  };
  const branchEntries = manager.getBranch();
  return { contextEntries: manager.buildContextEntries?.() ?? branchEntries, branchEntries };
}

function collectTranscriptEntries(
  source: EntrySource,
  parentId: string | undefined,
  { includeToolResults, humanOnly = false }: CollectOptions,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const askAnswers = capturedAskAnswers(source.branchEntries);
  const callInputs = new Map<string, unknown>();
  let briefSeen = false;

  for (const [index, entry] of source.contextEntries.entries()) {
    if (entry.type === "custom_message") {
      if (humanOnly) continue;
      const forwarded = agentMessageFromCustomEntry(entry, parentId);
      const job = forwarded || !includeToolResults ? undefined : backgroundJobResult(entry);
      if (forwarded?.body) {
        entries.push({
          index,
          order: 0,
          kind: "user",
          speaker: agentMessageLabel(forwarded),
          text: forwarded.body,
        });
      } else if (job) {
        entries.push({
          index,
          order: 0,
          kind: "result",
          text: "",
          result: { toolName: BACKGROUND_JOB_TOOL, ...job },
        });
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      content?: unknown;
      attribution?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
      details?: unknown;
    };
    if (message.role === "user") {
      const text = flattenUserContent(message.content).trim();
      if (!text) continue;
      if (humanOnly && message.attribution === AGENT_ATTRIBUTION) continue;
      const forwarded = agentMessageFromUserText(text, message.attribution);
      if (forwarded) {
        if (forwarded.body) {
          entries.push({
            index,
            order: 0,
            kind: "user",
            speaker: agentMessageLabel(forwarded),
            text: forwarded.body,
          });
        }
        continue;
      }
      entries.push({
        index,
        order: 0,
        kind: "user",
        speaker: USER_SPEAKER,
        text,
        pinned: !briefSeen,
      });
      briefSeen = true;
      continue;
    }
    if (message.role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : UNKNOWN_TOOL;
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      // A captured ask answer counts only while its result remains in context,
      // so branches and compaction drop it too.
      const answers = toolName === "ask" && message.isError !== true &&
          toolCallId !== undefined
        ? askAnswers.get(toolCallId) ?? []
        : [];
      if (answers.length > 0) {
        for (const [order, { question, answer }] of answers.entries()) {
          entries.push({
            index,
            order,
            kind: "user",
            speaker: USER_SPEAKER,
            text: `Answered ask question "${question}": ${answer}`,
            pinned: true,
            ask: true,
          });
        }
        continue;
      }
      if (humanOnly) continue;
      const forwarded = toolName === "wait"
        ? agentMessageFromWaitDetails(message.details, parentId)
        : undefined;
      if (forwarded) {
        if (forwarded.body) {
          entries.push({
            index,
            order: 0,
            kind: "user",
            speaker: agentMessageLabel(forwarded),
            text: forwarded.body,
          });
        }
        continue;
      }
      if (includeToolResults && !READ_ONLY_TOOLS.has(toolName)) {
        entries.push({
          index,
          order: 0,
          kind: "result",
          text: "",
          result: {
            toolName,
            call: toolCallId !== undefined && callInputs.has(toolCallId)
              ? summarizeToolCall(callInputs.get(toolCallId))
              : "",
            isError: message.isError === true,
            exitCode: exitCodeFromDetails(message.details),
            content: message.content,
          },
        });
      }
      continue;
    }
    if (message.role !== "assistant" || humanOnly) continue;

    for (const [order, toolCall] of collectAssistantToolCalls(
      message.content,
    ).entries()) {
      if (toolCall.id !== undefined) callInputs.set(toolCall.id, toolCall.input);
      entries.push({
        index,
        order,
        kind: "tool",
        text: `${toolCall.name}: ${safeJson(toolCall.input, 8000)}`,
      });
    }
  }

  // Only the newest answers stay pinned; older ones compete as ordinary messages.
  const askEntries = entries.filter((entry) => entry.ask);
  for (const entry of askEntries.slice(0, -MAX_PINNED_ASK_ANSWERS)) {
    entry.pinned = false;
  }
  return entries;
}

function selectUserEntries(
  entries: TranscriptEntry[],
  maxTokens: number,
  maxMessages: number,
): { selected: TranscriptEntry[]; omitted: boolean } {
  const users = entries.filter((entry) => entry.kind === "user");
  if (users.length === 0) return { selected: [], omitted: false };

  const distinctAnchors = users.length > 1;
  const anchorBudget = distinctAnchors
    ? Math.max(1, Math.floor(maxTokens / 2))
    : maxTokens;
  const rendered = users.map((entry) => {
    const entryCap = entry.ask
      ? MAX_ASK_ANSWER_ENTRY_TOKENS
      : entry.pinned
      ? MAX_BRIEF_ENTRY_TOKENS
      : MAX_USER_ENTRY_TOKENS;
    const truncated = truncateToTokenCap(
      `${entry.speaker ?? USER_SPEAKER}: ${entry.text}`,
      Math.min(entryCap, anchorBudget),
    );
    return { ...entry, text: truncated.text, truncated: truncated.truncated };
  });
  const selectedIndices = new Set<number>();
  let usedTokens = 0;

  // The brief, ask answers, and the latest message stay whatever the budgets
  // say; each is capped at half the token budget, so tiny budgets cannot let
  // one entry crowd out the rest.
  const latest = rendered.length - 1;
  for (const [position, entry] of rendered.entries()) {
    if (entry.pinned || position === latest) {
      selectedIndices.add(position);
      usedTokens += approximateTokenCount(entry.text);
    }
  }
  for (let position = latest - 1; position >= 0; position -= 1) {
    if (selectedIndices.size >= maxMessages) break;
    if (selectedIndices.has(position)) continue;
    const tokens = approximateTokenCount(rendered[position].text);
    if (usedTokens + tokens > maxTokens) continue;
    selectedIndices.add(position);
    usedTokens += tokens;
  }

  return {
    selected: rendered.filter((_entry, position) => selectedIndices.has(position)),
    omitted: selectedIndices.size < users.length || rendered.some((entry) =>
      entry.truncated
    ),
  };
}

function selectToolEntries(
  entries: TranscriptEntry[],
  maxTokens: number,
  maxCalls: number,
): { selected: TranscriptEntry[]; omitted: boolean } {
  const tools = entries.filter((entry) => entry.kind === "tool");
  const selected: TranscriptEntry[] = [];
  let usedTokens = 0;

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxCalls) break;
    const entry = tools[index];
    if (!entry) continue;
    const truncated = truncateToTokenCap(
      `ToolCall ${entry.text}`,
      Math.min(MAX_TOOL_ENTRY_TOKENS, maxTokens),
    );
    const tokens = approximateTokenCount(truncated.text);
    if (usedTokens + tokens > maxTokens) continue;
    selected.push({ ...entry, text: truncated.text });
    usedTokens += tokens;
  }

  selected.reverse();
  return {
    selected,
    omitted: selected.length < tools.length || tools.some((entry) =>
      approximateTokenCount(`ToolCall ${entry.text}`) >
        Math.min(MAX_TOOL_ENTRY_TOKENS, maxTokens)
    ),
  };
}

function selectResultEntries(
  entries: TranscriptEntry[],
  maxTokens: number,
  maxResults: number,
): { selected: TranscriptEntry[]; omitted: boolean } {
  const results = entries.filter((entry) => entry.kind === "result");
  const selected: TranscriptEntry[] = [];
  let usedTokens = 0;
  let truncated = false;

  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxResults) break;
    const entry = results[index];
    if (!entry?.result) continue;
    const rendered = renderToolResult(
      entry.result,
      Math.min(MAX_TOOL_RESULT_ENTRY_TOKENS, maxTokens - usedTokens),
    );
    // Older results would see an even smaller remainder.
    if (!rendered) break;
    selected.push({ ...entry, text: rendered.text });
    usedTokens += approximateTokenCount(rendered.text);
    truncated ||= rendered.truncated;
  }

  selected.reverse();
  return { selected, omitted: selected.length < results.length || truncated };
}

/**
 * The root session's user messages as their own block, above the agent's own
 * evidence. Only an OMP subagent has a root session above it, and only what
 * the user typed or answered there counts: injected messages, coordinator
 * traffic, tool calls, and tool results of the root stay out.
 */
function parentUserBlock(
  ctx: ExtensionContext,
  budgets: ClassifierTranscriptBudgets,
): string | undefined {
  if (!(budgets.includeParentUserMessages ?? DEFAULT_INCLUDE_PARENT_USER_MESSAGES)) {
    return undefined;
  }
  const rootEntries = findRootSessionEntries(ctx);
  if (!rootEntries) return undefined;
  const entries = collectTranscriptEntries(
    { contextEntries: rootEntries, branchEntries: rootEntries },
    undefined,
    { includeToolResults: false, humanOnly: true },
  ).map((entry) => ({ ...entry, speaker: PARENT_USER_SPEAKER }));
  const users = selectUserEntries(
    entries,
    budgets.maxParentUserTokens ?? DEFAULT_MAX_PARENT_USER_TRANSCRIPT_TOKENS,
    budgets.maxParentUserMessages ?? DEFAULT_MAX_PARENT_USER_TRANSCRIPT_MESSAGES,
  );
  if (users.selected.length === 0) return undefined;
  return [
    PARENT_USER_OPEN_TAG,
    ...users.selected.map((entry) => entry.text),
    ...(users.omitted ? [OMITTED_ENTRIES_MARKER] : []),
    PARENT_USER_CLOSE_TAG,
  ].join("\n");
}

/**
 * Build classifier evidence from user, coordinator, and peer messages, verified
 * ask answers, assistant tool-call payloads, and bounded untrusted excerpts of
 * recent tool results. Under an OMP subagent it opens with the root session's
 * user messages.
 */
export function buildClassifierTranscript(
  ctx: ExtensionContext,
  budgets: ClassifierTranscriptBudgets,
): string {
  const entries = collectTranscriptEntries(
    sessionEntrySource(ctx.sessionManager),
    parentAgentId(ctx),
    { includeToolResults: budgets.includeToolResults ?? DEFAULT_INCLUDE_TOOL_RESULTS },
  );
  const users = selectUserEntries(
    entries,
    budgets.maxUserTokens,
    budgets.maxUserMessages ?? DEFAULT_MAX_USER_TRANSCRIPT_MESSAGES,
  );
  const tools = selectToolEntries(
    entries,
    budgets.maxToolTokens,
    budgets.maxToolCalls ?? DEFAULT_MAX_TOOL_TRANSCRIPT_CALLS,
  );
  const results = selectResultEntries(
    entries,
    budgets.maxToolResultTokens ?? DEFAULT_MAX_TOOL_RESULT_TRANSCRIPT_TOKENS,
    budgets.maxToolResults ?? DEFAULT_MAX_TOOL_RESULT_TRANSCRIPT_ENTRIES,
  );
  const selected = [...users.selected, ...tools.selected, ...results.selected].sort(
    (left, right) => left.index - right.index || left.order - right.order,
  );
  if (users.omitted || tools.omitted || results.omitted) {
    selected.push({
      index: Number.MAX_SAFE_INTEGER,
      order: 0,
      kind: "tool",
      text: OMITTED_ENTRIES_MARKER,
    });
  }
  const lines = selected.map((entry) => entry.text);
  const parent = parentUserBlock(ctx, budgets);
  return (parent === undefined ? lines : [parent, ...lines]).join("\n");
}

export function loadedContextFromSystemPromptOptions(options: unknown): string {
  const contextFiles = (
    options as
      | { contextFiles?: Array<{ path?: string; content?: string }> }
      | undefined
  )?.contextFiles;
  if (!Array.isArray(contextFiles)) return "";
  return contextFiles
    .map(
      (file) =>
        `# ${file.path ?? "context"}\n${
          truncateMiddle(file.content ?? "", 4000)
        }`,
    )
    .join("\n\n");
}
