/**
 * Provider-independent agent conversation protocol for CoderXP M3.3.
 *
 * This module defines the contracts only. It contains no vendor code,
 * no network calls, no API keys, and no provider SDK imports. A concrete
 * provider adapter is a later milestone (M3.9); nothing here depends on
 * which provider eventually implements AgentTransport.
 *
 * Milestone sequence for context:
 *   M3.3  chat/conversation foundation   <- this file
 *   M3.4  filesystem tools / sync
 *   M3.5  terminal/runtime agent tools
 *   M3.6  permissions
 *   M3.7  execution loop
 *   M3.8  timeline / cancellation
 *   M3.9  provider adapters
 *   M3.10 stabilization
 */

// ---------------------------------------------------------------------------
// Message identity
// ---------------------------------------------------------------------------

/** Author of a conversation message. Provider-independent. */
export type AgentMessageRole = "user" | "assistant" | "system" | "tool";

/** Lifecycle state of a single message. */
export type AgentMessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "error"
  | "cancelled";

// ---------------------------------------------------------------------------
// Structured blocks
// ---------------------------------------------------------------------------

/**
 * Discriminated block kinds a message body may contain.
 *
 * Blocks are the durable, rendered representation. Events (below) are the
 * transport-level deltas that produce or update them.
 */
export type AgentBlockKind =
  | "text"
  | "command-started"
  | "command-output"
  | "command-completed"
  | "file-read"
  | "file-modified"
  | "tool-call"
  | "tool-result"
  | "approval-requested"
  | "error"
  | "cancellation";

interface AgentBlockBase {
  /** Stable id within the owning message. */
  id: string;
  kind: AgentBlockKind;
}

/** Prose or fenced-code text emitted by the agent. */
export interface AgentTextBlock extends AgentBlockBase {
  kind: "text";
  text: string;
}

/** A shell command the agent started. */
export interface AgentCommandStartedBlock extends AgentBlockBase {
  kind: "command-started";
  /** Correlates started/output/completed blocks for one command. */
  commandId: string;
  command: string;
}

/** Incremental stdout/stderr for a running command. */
export interface AgentCommandOutputBlock extends AgentBlockBase {
  kind: "command-output";
  commandId: string;
  chunk: string;
  stream: "stdout" | "stderr";
}

/** Terminal state of a command the agent started. */
export interface AgentCommandCompletedBlock extends AgentBlockBase {
  kind: "command-completed";
  commandId: string;
  exitCode: number | null;
  /** True when the command was cancelled rather than exiting on its own. */
  cancelled?: boolean;
}

/** A workspace file the agent read. */
export interface AgentFileReadBlock extends AgentBlockBase {
  kind: "file-read";
  path: string;
  /** Byte length read, when known. */
  bytes?: number;
}

/** A workspace file the agent created, edited, or deleted. */
export interface AgentFileModifiedBlock extends AgentBlockBase {
  kind: "file-modified";
  path: string;
  change: "created" | "updated" | "deleted";
}

/** A tool invocation requested by the agent. */
export interface AgentToolCallBlock extends AgentBlockBase {
  kind: "tool-call";
  /** Correlates a tool-call with its tool-result. */
  toolCallId: string;
  name: string;
  /** Serialized arguments. Kept opaque at the protocol layer. */
  input: string;
}

/** The result returned for a prior tool-call. */
export interface AgentToolResultBlock extends AgentBlockBase {
  kind: "tool-result";
  toolCallId: string;
  /** Serialized result. Kept opaque at the protocol layer. */
  output: string;
  isError?: boolean;
}

/**
 * A gated action awaiting user approval.
 *
 * M3.6 owns the permission system. This block only carries the request so
 * the protocol does not have to change when permissions land.
 */
export interface AgentApprovalRequestedBlock extends AgentBlockBase {
  kind: "approval-requested";
  approvalId: string;
  summary: string;
}

/** A failure surfaced inside the transcript. */
export interface AgentErrorBlock extends AgentBlockBase {
  kind: "error";
  message: string;
}

/** A user-initiated or project-switch cancellation. */
export interface AgentCancellationBlock extends AgentBlockBase {
  kind: "cancellation";
  reason: string;
}

export type AgentBlock =
  | AgentTextBlock
  | AgentCommandStartedBlock
  | AgentCommandOutputBlock
  | AgentCommandCompletedBlock
  | AgentFileReadBlock
  | AgentFileModifiedBlock
  | AgentToolCallBlock
  | AgentToolResultBlock
  | AgentApprovalRequestedBlock
  | AgentErrorBlock
  | AgentCancellationBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A single provider-independent conversation message. */
export interface AgentMessage {
  /** Stable local id. Never a provider id. */
  id: string;
  role: AgentMessageRole;
  /** Ordered structured content. Plain text is a single "text" block. */
  content: AgentBlock[];
  /** Unix timestamp (ms) the message was created locally. */
  createdAt: number;
  status: AgentMessageStatus;
}

/** Concatenated text of a message, for composer echo and copy paths. */
export function messageText(message: AgentMessage): string {
  return message.content
    .filter((block): block is AgentTextBlock => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Transport events
// ---------------------------------------------------------------------------

/**
 * Transport-level deltas.
 *
 * "text-delta" appends to the trailing text block. "block" appends a new
 * structured block or replaces an existing one with the same id, which
 * lets a transport stream command output incrementally.
 */
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "block"; block: AgentBlock }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * The boundary every provider adapter must implement.
 *
 * Deliberately minimal: a request in, an async stream of events out. The
 * signal is how cancellation reaches the provider. No provider type,
 * credential, or endpoint appears in this contract.
 */
export interface AgentTransport {
  send(
    request: AgentSendRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
}

/** Input handed to a transport for one assistant turn. */
export interface AgentSendRequest {
  /** Project that owns the conversation. */
  projectId: string;
  /** Full prior transcript, oldest first. */
  messages: AgentMessage[];
}

/** Shown verbatim when no transport is configured. Never a fake reply. */
export const AGENT_NOT_CONNECTED_MESSAGE = "Agent provider not connected";
