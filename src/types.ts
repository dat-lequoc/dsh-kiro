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

/** The complete request body. */
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

/** A decoded event-stream frame: its headers plus its raw payload bytes. */
export interface WireFrame {
  /** Frame headers; `:event-type` or `:exception-type` names the payload. */
  headers: Record<string, string>
  /** Undecoded payload bytes, JSON for every event this adapter reads. */
  payload: Uint8Array
}
