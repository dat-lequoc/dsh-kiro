/**
 * Verification-only DSH plugin: a provider route that reproduces the exact
 * failure the audit reported, without spending provider credits.
 *
 * The route classifies a recorded real Kiro HTTP 400 body through dsh-kiro's own
 * `httpErrorCode`, so the error code under test is the adapter's real output, and
 * the rest of the stack — agent loop, token meter, compaction-basic, retry — is
 * the genuine installed code. The call sequence is scripted:
 *
 *   1. first request        -> one tool call, so the turn produces durable history
 *   2. request after tools  -> throw the classified context-overflow failure
 *   3. compaction summary   -> a short summary (purpose === 'compaction')
 *   4. retried request      -> the final answer
 *
 * Every call is appended to $KIRO_PROBE_TRACE as JSON lines.
 */

import { appendFileSync } from 'node:fs'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { httpErrorCode } from 'dsh-kiro'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The body Kiro really returned for an oversized request, captured live. */
const REAL_OVERFLOW_BODY = JSON.stringify({
  message: 'Input is too long.',
  reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
})

const TRACE = process.env.KIRO_PROBE_TRACE ?? '/tmp/kiro-probe-trace.jsonl'

function trace(entry) {
  appendFileSync(TRACE, `${JSON.stringify(entry)}\n`)
}

/** Does this request already carry tool output, i.e. is it a post-tool step? */
function hasToolResult(messages) {
  return messages.some(message =>
    (message.content ?? []).some(block => block.type === 'tool-result'))
}

/** Pick the shell-like tool DSH offered, so the call is executable. */
function shellTool(tools) {
  return (tools ?? []).find(tool => /bash|shell|exec|terminal/iu.test(tool.name))
}

class OverflowProbeAdapter extends LlmAdapter {
  constructor() {
    super()
    this.calls = 0
    this.overflowsThrown = 0
  }

  providerInfo(provider) {
    return { id: provider, name: 'Kiro overflow probe' }
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: 'probe-1', name: 'Probe 1', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      // Small enough that the token meter has real numbers to work with.
      context: { contextWindow: 200_000 },
    })
  }

  async * stream(options) {
    this.calls += 1
    const purpose = options.purpose
    const postTool = hasToolResult(options.messages)
    trace({
      call: this.calls,
      purpose: purpose ?? null,
      messages: options.messages.length,
      postTool,
      overflowsThrown: this.overflowsThrown,
    })

    // The compaction summarizer runs through the same route; answer it plainly.
    if (purpose === 'compaction') {
      yield * this.text('Earlier turns were condensed by the probe summarizer.')
      return
    }

    if (postTool && this.overflowsThrown === 0) {
      this.overflowsThrown += 1
      const code = httpErrorCode(400, REAL_OVERFLOW_BODY)
      trace({ call: this.calls, threw: code })
      throw new LlmError('Input is too long.', code, { status: 400 })
    }

    if (!postTool && this.overflowsThrown === 0) {
      const tool = shellTool(options.tools)
      if (tool === undefined) {
        trace({ call: this.calls, note: 'no shell tool offered; answering directly' })
        yield * this.text('probe-no-tool')
        return
      }
      yield * this.toolCall(tool.name, JSON.stringify({
        command: 'echo probe-tool-ok',
        description: 'probe tool step',
      }))
      return
    }

    // Reached only after the overflow, i.e. on the retried request.
    trace({ call: this.calls, note: 'answering after recovery' })
    yield * this.text('recovered-ok')
  }

  * text(value) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: value }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  * toolCall(name, args) {
    const id = CallId(`probe-call-${this.calls}`)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'dsh-kiro-overflow-probe'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['kiro-probe'], new OverflowProbeAdapter())
}
