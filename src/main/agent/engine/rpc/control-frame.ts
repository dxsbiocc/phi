import type { PhiToolResult } from '../types'
import type { RpcControlFrame } from './types'
import { MAX_RPC_FRAME_BYTES } from './frame-codec'

export function rpcRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function rpcIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  )
}

function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

export function validToolResult(value: unknown): value is PhiToolResult {
  return (
    rpcRecord(value) &&
    only(value, ['content', 'details', 'isError']) &&
    (value.isError === undefined || typeof value.isError === 'boolean') &&
    Array.isArray(value.content) &&
    value.content.every(
      (part) =>
        rpcRecord(part) &&
        ((part.type === 'text' && typeof part.text === 'string' && only(part, ['type', 'text'])) ||
          (part.type === 'image' &&
            typeof part.data === 'string' &&
            typeof part.mimeType === 'string' &&
            only(part, ['type', 'data', 'mimeType'])))
    )
  )
}

/** Reject arbitrary commands and malformed control shapes before the shared writer sees them. */
export function validateControlFrame(value: unknown): asserts value is RpcControlFrame {
  if (!rpcRecord(value) || !rpcIdentifier(value.id)) throw new Error('Invalid RPC control frame')
  if (
    value.type === 'host_tool_update' &&
    only(value, ['type', 'id', 'partialResult']) &&
    validToolResult(value.partialResult)
  )
    return
  if (
    value.type === 'host_tool_result' &&
    only(value, ['type', 'id', 'result', 'isError']) &&
    validToolResult(value.result) &&
    (value.isError === undefined || typeof value.isError === 'boolean')
  )
    return
  if (
    value.type === 'host_uri_result' &&
    only(value, [
      'type',
      'id',
      'content',
      'contentType',
      'notes',
      'immutable',
      'isError',
      'error'
    ]) &&
    (value.content === undefined ||
      (typeof value.content === 'string' &&
        Buffer.byteLength(value.content) <= MAX_RPC_FRAME_BYTES)) &&
    (value.error === undefined ||
      (typeof value.error === 'string' && Buffer.byteLength(value.error) <= 4096)) &&
    (value.contentType === undefined ||
      (typeof value.contentType === 'string' &&
        ['text/markdown', 'application/json', 'text/plain'].includes(value.contentType))) &&
    (value.immutable === undefined || typeof value.immutable === 'boolean') &&
    (value.isError === undefined || typeof value.isError === 'boolean') &&
    (value.notes === undefined ||
      (Array.isArray(value.notes) &&
        value.notes.length <= 32 &&
        value.notes.every((note) => typeof note === 'string' && Buffer.byteLength(note) <= 4096)))
  )
    return
  if (value.type === 'extension_ui_response') {
    if (only(value, ['type', 'id', 'value']) && typeof value.value === 'string') return
    if (only(value, ['type', 'id', 'confirmed']) && typeof value.confirmed === 'boolean') return
    if (
      only(value, ['type', 'id', 'cancelled', 'timedOut']) &&
      value.cancelled === true &&
      (value.timedOut === undefined || typeof value.timedOut === 'boolean')
    )
      return
    if (
      only(value, ['type', 'id', 'answers']) &&
      Array.isArray(value.answers) &&
      value.answers.every(
        (answer) =>
          rpcRecord(answer) &&
          only(answer, ['id', 'selectedOptions', 'customInput']) &&
          rpcIdentifier(answer.id) &&
          Array.isArray(answer.selectedOptions) &&
          answer.selectedOptions.every((option) => typeof option === 'string') &&
          (answer.customInput === undefined || typeof answer.customInput === 'string')
      )
    )
      return
  }
  throw new Error('Invalid RPC control frame')
}
