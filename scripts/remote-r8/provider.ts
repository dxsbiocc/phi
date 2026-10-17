import assert from 'node:assert/strict'

import type { ModelReply, ModelRequest } from '../../tests/helpers/rpcHostResultModel'
import type { RequestPurposes } from './application-types'

const SUMMARY_SYSTEM =
  'NEVER continue the conversation or answer its questions. Output ONLY the structured summary.'
export const CHILD_PROMPT_MARKER = 'PRIVATE_R8_INSPECTOR'

/**
 * Classifies each synthetic model request by its system prompt, never by order, and answers
 * compaction summaries. Returning undefined leaves the reply to the scripted queue.
 */
export function classifyingReplyFor(
  purposes: RequestPurposes
): (request: ModelRequest) => ModelReply | undefined {
  return (request) => {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => JSON.stringify(message.content))
      .join('\n')
    if (system.includes(SUMMARY_SYSTEM)) {
      purposes.summary++
      assert.ok(purposes.summary <= 8, 'Unexpected compaction summary loop')
      return {
        text: 'R8_COMPACTION_SUMMARY: The search, edit and bounded bash completed once. Preserve original facts. Continue only on an explicit new user request.'
      }
    }
    if (system.includes(CHILD_PROMPT_MARKER)) purposes.child++
    else purposes.root++
    assert.ok(purposes.root + purposes.child <= 35, 'Unexpected model continuation')
    return undefined
  }
}
