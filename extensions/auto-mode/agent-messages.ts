const PARENT_IRC_SENDER = "parent";
const IRC_INCOMING_ENTRY = "irc:incoming";
const ASYNC_RESULT_ENTRY = "async-result";
const MAX_SENDER_CHARS = 64;
const AGENT_ATTRIBUTION = "agent";

// The harness renders a parent's steering message as an optional `[…]` banner
// line followed by this envelope. The envelope body is escaped, so the first
// closing tag is the real one.
const IRC_WRAPPER = /^(?:\[[^\]\n]*\]\n)?<irc from="([^"\n]*)" agent="([^"\n]*)">\n([\s\S]*?)\n?<\/irc>\s*$/;

/** How much authority a message from another agent carries. */
export type AgentAuthority = "coordinator" | "peer";

export type AgentMessage = {
  authority: AgentAuthority;
  sender: string;
  body: string;
};

export type BackgroundJobResult = {
  call: string;
  isError: boolean;
  content: unknown;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sanitizeSender(sender: string): string {
  return sender.replace(/[^\w.:-]/g, "_").slice(0, MAX_SENDER_CHARS) || "unknown";
}

/** Transcript label for an agent message, for example `Coordinator Main`. */
export function agentMessageLabel(message: AgentMessage): string {
  return message.authority === "coordinator"
    ? `Coordinator ${message.sender}`
    : `Peer agent ${message.sender}`;
}

/**
 * The registry id of the agent that spawned this session, or undefined for a
 * main session, Pi, and OMP versions that do not report it.
 */
export function parentAgentId(ctx: object): string | undefined {
  const agent = "agent" in ctx ? record(ctx.agent) : undefined;
  return typeof agent?.parentId === "string" && agent.parentId.length > 0
    ? agent.parentId
    : undefined;
}

/**
 * Re-attribute a user-role message that OMP injected on behalf of another
 * agent. Only messages the harness attributed to an agent qualify, so text the
 * human types can never pose as a coordinator.
 */
export function agentMessageFromUserText(
  text: string,
  attribution: unknown,
): AgentMessage | undefined {
  if (attribution !== AGENT_ATTRIBUTION) return undefined;
  const match = IRC_WRAPPER.exec(text);
  if (!match) return undefined;
  const [, from = "", agent = "", body = ""] = match;
  return {
    authority: from === PARENT_IRC_SENDER ? "coordinator" : "peer",
    sender: sanitizeSender(agent),
    body: body.trim(),
  };
}

/** An `irc:incoming` custom message OMP appended to the session. */
export function agentMessageFromCustomEntry(
  entry: { customType?: unknown; content?: unknown; details?: unknown },
  parentId: string | undefined,
): AgentMessage | undefined {
  if (entry.customType !== IRC_INCOMING_ENTRY) return undefined;
  const details = record(entry.details);
  const from = details?.from;
  if (typeof from !== "string") return undefined;
  const raw = details?.message ?? entry.content;
  if (typeof raw !== "string") return undefined;
  const fromParent = details?.fromParent === true || from === parentId;
  return {
    authority: fromParent ? "coordinator" : "peer",
    sender: sanitizeSender(from),
    body: raw.trim(),
  };
}

/** A message another agent sent, delivered as the result of the `wait` tool. */
export function agentMessageFromWaitDetails(
  details: unknown,
  parentId: string | undefined,
): AgentMessage | undefined {
  const waited = record(record(details)?.waited);
  if (typeof waited?.from !== "string" || typeof waited.body !== "string") return undefined;
  return {
    authority: waited.from === parentId ? "coordinator" : "peer",
    sender: sanitizeSender(waited.from),
    body: waited.body.trim(),
  };
}

/** An `async-result` custom message: the output of a finished background job. */
export function backgroundJobResult(
  entry: { customType?: unknown; content?: unknown; details?: unknown },
): BackgroundJobResult | undefined {
  if (entry.customType !== ASYNC_RESULT_ENTRY) return undefined;
  const jobs = record(entry.details)?.jobs;
  const described = Array.isArray(jobs)
    ? jobs.flatMap((job) => {
      const fields = record(job);
      const label = fields?.label ?? fields?.jobId;
      return typeof label === "string"
        ? [{ label, failed: fields?.status === "failed" || fields?.status === "cancelled" }]
        : [];
    })
    : [];
  return {
    call: described.map(({ label }) => label).join(", "),
    isError: described.some(({ failed }) => failed),
    content: entry.content,
  };
}
