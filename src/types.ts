/**
 * Wire types for the Kiro (CodeWhisperer) `generateAssistantResponse`
 * operation. The request is JSON; the response is a
 * `vnd.amazon.eventstream` frame sequence whose payloads are the JSON events
 * declared here.
 *
 * @module dsh-kiro/types
 */

/** One tool schema as CodeWhisperer accepts it. */
export interface WireTool {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: Record<string, unknown> }
  }
}

/** One completed tool result sent back to the model. */
export interface WireToolResult {
  toolUseId: string
  content: { text: string }[]
  status: 'success' | 'error'
}

/** One model-issued tool call replayed in history. */
export interface WireToolUse {
  toolUseId: string
  name: string
  input: unknown
}

/** Per-turn context accompanying a user message. */
export interface WireUserInputMessageContext {
  tools?: WireTool[]
  toolResults?: WireToolResult[]
}

/** A user turn. `modelId` repeats on every turn, as the service requires. */
export interface WireUserInputMessage {
  content: string
  modelId: string
  origin: string
  userInputMessageContext?: WireUserInputMessageContext
}

/** An assistant turn replayed in history. */
export interface WireAssistantResponseMessage {
  content: string
  toolUses?: WireToolUse[]
}

/** One history entry: exactly one of the two roles. */
export type WireHistoryEntry =
  | { userInputMessage: WireUserInputMessage }
  | { assistantResponseMessage: WireAssistantResponseMessage }

/**
 * The complete request body.
 *
 * These are every member the operation declares. Notably there is no
 * `inferenceConfig`: an output cap travels inside
 * {@link WireRequest.additionalModelRequestFields}, validated against the
 * selected model's advertised schema, and a top-level generation object is
 * dropped by the service without an error.
 */
export interface WireRequest {
  profileArn?: string
  additionalModelRequestFields?: Record<string, unknown>
  conversationState: {
    chatTriggerType: 'MANUAL'
    conversationId: string
    currentMessage: { userInputMessage: WireUserInputMessage }
    history?: WireHistoryEntry[]
  }
}

/** Visible or thinking text produced by the model. */
export interface WireAssistantResponseEvent {
  content: string
  modelId?: string
}

/**
 * One step of a streamed tool call. The first frame carries `name` and
 * `toolUseId` alone, argument frames add `input` fragments, and the last
 * carries `stop: true`.
 */
export interface WireToolUseEvent {
  toolUseId: string
  name?: string
  input?: string
  stop?: boolean
}

/** Fraction of the model's context the request consumed, as a percentage. */
export interface WireContextUsageEvent {
  contextUsagePercentage: number
}

/** Account credits this request consumed. */
export interface WireMeteringEvent {
  unit: string
  unitPlural: string
  usage: number
}

/**
 * Exact token counters reported at the end of a model call.
 *
 * The wire schema declares seven members. The four bucket counters are disjoint;
 * `totalTokens` is their sum, and the last two are not buckets at all —
 * `contextUsagePercentage` repeats the standalone `contextUsageEvent`, and
 * `normalizedTokenUsage` is Kiro's own credit-normalized figure.
 */
export interface WireTokenUsage {
  uncachedInputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  contextUsagePercentage?: number
  normalizedTokenUsage?: number
}

/**
 * Native reasoning frame. Kiro delivers model reasoning out of band rather than
 * inside the visible text channel whenever the request selected a native effort.
 * A frame carries any one of the three forms: incremental `text`, a `signature`
 * attesting the reasoning block, or `redactedContent` standing in for reasoning
 * the service withheld.
 */
export interface WireReasoningContentEvent {
  /** Incremental reasoning text; fragmented across frames like visible text. */
  text?: string
  /** Opaque provider attestation for the reasoning block. */
  signature?: string
  /** Base64 stand-in for reasoning the service withheld. */
  redactedContent?: string
}

/** Why the model declined, as reported alongside a refusal stop reason. */
export interface WireRefusalDetails {
  category?: string
  explanation?: string
  recommendedModel?: string
}

/** Structured detail accompanying a terminal stop reason. */
export interface WireStopDetails {
  refusal?: WireRefusalDetails
}

/**
 * Terminal response metadata. `stopReason` carries Kiro's `StopReason`
 * vocabulary (`END_TURN`, `TOOL_USE`, `MAX_TOKENS`,
 * `MODEL_CONTEXT_WINDOW_EXCEEDED`, `CONTENT_FILTERED`, `PAUSE_TURN`,
 * `UNKNOWN`); Kiro may add other metadata fields over time.
 */
export interface WireMetadataEvent {
  tokenUsage?: WireTokenUsage
  stopReason?: string
  stopDetails?: WireStopDetails
}

/** A decoded event-stream frame: its headers plus its raw payload bytes. */
export interface WireFrame {
  /** Frame headers; `:event-type` or `:exception-type` names the payload. */
  headers: Record<string, string>
  /** Undecoded payload bytes, JSON for every event this adapter reads. */
  payload: Uint8Array
}
