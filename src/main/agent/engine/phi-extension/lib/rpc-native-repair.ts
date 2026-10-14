import type { AssistantMessageEvent } from '@oh-my-pi/pi-ai'
import { integrity, object, validateNativeContent, type NativeSseCapture } from './rpc-native-sse'

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (object(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable(value[key]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? 'undefined'
}
function anchor(block: Record<string, unknown>): string {
  if (block.type === 'thinking' && block.thinkingSignature)
    return 'signature:' + block.thinkingSignature
  if (block.type === 'toolCall') return 'tool:' + block.id + ':' + block.name
  return stable(block)
}
function unique(blocks: Array<Record<string, unknown>>): void {
  const seen = new Set<string>()
  for (const block of blocks) {
    const key = anchor(block)
    integrity(!seen.has(key))
    seen.add(key)
  }
}

/** Restore only losses uniquely proved by the original successful native terminal. */
export function repairNativeTerminal(
  original: AssistantMessageEvent,
  capture: NativeSseCapture,
  identity: { provider: string; id: string }
): AssistantMessageEvent {
  const raw = capture.rawTerminal
  if (original.type !== 'done') return original
  integrity(raw?.type === 'done')
  const before = raw.message
  const after = original.message
  integrity(
    before.role === 'assistant' &&
      after.role === 'assistant' &&
      before.provider === identity.provider &&
      before.model === identity.id &&
      after.provider === before.provider &&
      after.model === before.model &&
      after.api === before.api &&
      original.reason === raw.reason &&
      before.stopReason === after.stopReason &&
      after.stopReason === original.reason
  )
  validateNativeContent(before.content)
  validateNativeContent(after.content)
  const source = before.content as unknown as Array<Record<string, unknown>>
  const base = after.content as unknown as Array<Record<string, unknown>>
  const needsOpaque = source.some(
    (block) =>
      block.type === 'redactedThinking' &&
      !base.some(
        (candidate) => candidate.type === 'redactedThinking' && candidate.data === block.data
      )
  )
  const needsSparse = source.some(
    (block, index) =>
      block.type === 'thinking' &&
      block.thinkingSignature &&
      block.thinking &&
      !capture.thinkingDeltas.has(index) &&
      base.some(
        (candidate) =>
          candidate.type === 'thinking' &&
          candidate.thinkingSignature === block.thinkingSignature &&
          candidate.thinking === ''
      )
  )
  if (!needsOpaque && !needsSparse) return original
  if (needsOpaque) integrity(source.some((block) => block.type !== 'redactedThinking'))
  unique(source)
  unique(base)
  const repaired: Array<Record<string, unknown>> = []
  let cursor = 0
  for (let index = 0; index < source.length; index++) {
    const rawBlock = source[index]
    const existing = base[cursor]
    if (rawBlock.type === 'redactedThinking') {
      if (existing?.type === 'redactedThinking' && existing.data === rawBlock.data) {
        repaired.push(existing)
        cursor++
      } else {
        integrity(existing?.type !== 'redactedThinking')
        repaired.push({ type: 'redactedThinking', data: rawBlock.data })
      }
      continue
    }
    integrity(existing && existing.type === rawBlock.type && anchor(existing) === anchor(rawBlock))
    if (rawBlock.type === 'thinking' && rawBlock.thinkingSignature) {
      integrity(existing.itemId === rawBlock.itemId)
      if (
        existing.thinking === '' &&
        rawBlock.thinking !== '' &&
        !capture.thinkingDeltas.has(index)
      )
        repaired.push({ ...existing, thinking: rawBlock.thinking })
      else {
        integrity(existing.thinking === rawBlock.thinking)
        repaired.push(existing)
      }
    } else {
      integrity(stable(existing) === stable(rawBlock))
      repaired.push(existing)
    }
    cursor++
  }
  integrity(cursor === base.length)
  return {
    ...original,
    message: { ...after, content: repaired as unknown as typeof after.content }
  }
}
