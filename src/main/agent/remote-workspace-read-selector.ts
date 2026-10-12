import {
  readRemoteWorkspaceFileRange,
  type RemoteFileSnapshot
} from './remote-workspace-file-content'
import type { RemoteSshSession } from './wrappers/remote-ssh-session'

type RemoteReadRange = { start: number; end?: number }

export type RemoteReadSelector = {
  raw: boolean
  ranges?: RemoteReadRange[]
  tail?: number
}

export type RemoteTextWindow = {
  content: string
  truncated: boolean
  continuation?: string
  binary?: true
}

export const REMOTE_AGENT_TEXT_MAX_LINES = 300
const EXPLICIT_MAX_LINES = 3000
export const REMOTE_AGENT_TEXT_MAX_BYTES = 50 * 1024
const SCAN_CHUNK_BYTES = 64 * 1024
const COUNT_LINES_TO_EOF_BYTES = 1024 * 1024

function parseRange(value: string): RemoteReadRange | null {
  let match = /^(\d+)$/.exec(value)
  if (match) return { start: Number(match[1]) }
  match = /^(\d+)-(\d+)$/.exec(value)
  if (match) {
    const start = Number(match[1])
    const end = Number(match[2])
    return start <= end ? { start, end } : null
  }
  match = /^(\d+)\+(\d+)$/.exec(value)
  if (match) {
    const start = Number(match[1])
    const count = Number(match[2])
    return count > 0 ? { start, end: start + count - 1 } : null
  }
  match = /^(\d+)-$/.exec(value)
  return match ? { start: Number(match[1]) } : null
}

function validRange(range: RemoteReadRange | null): range is RemoteReadRange {
  return Boolean(
    range &&
    Number.isSafeInteger(range.start) &&
    range.start > 0 &&
    (range.end === undefined || (Number.isSafeInteger(range.end) && range.end >= range.start))
  )
}

function mergeRanges(ranges: RemoteReadRange[]): RemoteReadRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start)
  const merged: RemoteReadRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous) {
      merged.push(range)
      continue
    }
    if (previous.end === undefined) continue
    if (range.start > previous.end + 1) {
      merged.push(range)
      continue
    }
    previous.end = range.end === undefined ? undefined : Math.max(previous.end, range.end)
  }
  return merged
}

export function splitRemoteReadSelector(path: string): {
  path: string
  selector?: RemoteReadSelector
} {
  const colon = path.lastIndexOf(':')
  if (colon <= path.lastIndexOf('/')) return { path }
  let suffix = path.slice(colon + 1)
  let raw = false
  let base = path.slice(0, colon)
  if (base.toLowerCase().endsWith(':raw')) {
    raw = true
    base = base.slice(0, -4)
  }
  if (suffix.toLowerCase() === 'raw') {
    raw = true
    const preceding = base.lastIndexOf(':')
    if (preceding > base.lastIndexOf('/')) {
      suffix = base.slice(preceding + 1)
      base = base.slice(0, preceding)
    } else {
      return { path: base, selector: { raw: true } }
    }
  } else if (suffix.toLowerCase().startsWith('raw:')) {
    raw = true
    suffix = suffix.slice(4)
  }

  const tail = /^-(\d+)$/.exec(suffix)
  if (tail) {
    const count = Number(tail[1])
    return Number.isSafeInteger(count) && count > 0 && count <= EXPLICIT_MAX_LINES
      ? { path: base, selector: { raw, tail: count } }
      : { path }
  }

  const ranges = suffix.split(',').map(parseRange)
  if (ranges.length > 0 && ranges.every(validRange)) {
    return { path: base, selector: { raw, ranges: mergeRanges(ranges) } }
  }
  return { path }
}

function selectedBy(selector: RemoteReadSelector | undefined, line: number): boolean {
  if (!selector?.ranges) return line <= REMOTE_AGENT_TEXT_MAX_LINES
  return selector.ranges.some(
    (range) => line >= range.start && (range.end === undefined || line <= range.end)
  )
}

function maximumSelectedLine(selector: RemoteReadSelector | undefined): number {
  if (!selector?.ranges) return REMOTE_AGENT_TEXT_MAX_LINES
  if (selector.ranges.some((range) => range.end === undefined)) return Number.POSITIVE_INFINITY
  return Math.max(...selector.ranges.map((range) => range.end!))
}

function selectorForDisplay(
  selector: RemoteReadSelector | undefined
): RemoteReadSelector | undefined {
  if (!selector?.ranges || selector.raw || selector.ranges.length !== 1) return selector
  const [range] = selector.ranges
  return {
    ...selector,
    ranges: [
      {
        start: Math.max(1, range.start - 1),
        ...(range.end === undefined ? {} : { end: range.end + 3 })
      }
    ]
  }
}

function textPrefixAtUtf8Boundary(bytes: Buffer, maxBytes: number): string {
  const capped = bytes.subarray(0, maxBytes)
  for (let trim = 0; trim <= 3 && trim <= capped.length; trim += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        capped.subarray(0, capped.length - trim)
      )
    } catch {
      // A bounded read may end in the middle of one UTF-8 code point.
    }
  }
  return ''
}

function boundedLine(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line
  const prefix = textPrefixAtUtf8Boundary(Buffer.from(line), Math.max(0, maxBytes - 3))
  return `${prefix}…`
}

export async function readRemoteTextWindow(
  session: RemoteSshSession,
  target: { path: string; canonicalRoot: string },
  snapshot: RemoteFileSnapshot,
  selector?: RemoteReadSelector
): Promise<RemoteTextWindow> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const selected: string[] = []
  const tailLines: Array<{ text: string; truncated: boolean }> = []
  const displaySelector = selectorForDisplay(selector)
  const maxLine = maximumSelectedLine(displaySelector)
  const lineLimit = selector ? EXPLICIT_MAX_LINES : REMOTE_AGENT_TEXT_MAX_LINES
  const tailCapacity = (selector?.tail ?? 0) + (selector?.tail && !selector.raw ? 1 : 0)
  const tailLineBytes = Math.max(
    16,
    Math.floor(REMOTE_AGENT_TEXT_MAX_BYTES / (tailCapacity || 1)) - 16
  )
  const scanPastRange = snapshot.size <= COUNT_LINES_TO_EOF_BYTES
  let offset = 0
  let lineNumber = 1
  let pending = ''
  let selectedBytes = 0
  let selectedCount = 0
  let previousSelectedLine: number | undefined
  let discardingLine = false
  let discardedTailPrefix = ''
  let stoppedByBudget = false
  let stoppedByRange = false
  let stoppedEarlyByRange = false
  let endedWithNewline = false

  const renderLine = (line: string): string => {
    const text = selector?.raw || !line.endsWith('\r') ? line : line.slice(0, -1)
    return selector?.raw ? text : `${lineNumber}|${text}`
  }

  const keepLine = (line: string, forcedTruncation = false): boolean => {
    if (selector?.tail !== undefined) {
      const raw = selector.raw || !line.endsWith('\r') ? line : line.slice(0, -1)
      const bounded = boundedLine(raw, tailLineBytes)
      tailLines.push({
        text: selector.raw ? bounded : `${lineNumber}|${bounded}`,
        truncated: forcedTruncation || bounded !== raw
      })
      if (tailLines.length > tailCapacity) tailLines.shift()
      return true
    }
    if (!selectedBy(displaySelector, lineNumber)) return true
    const rendered = renderLine(line)
    const bytes = Buffer.byteLength(rendered, 'utf8') + (selected.length > 0 ? 1 : 0)
    if (selectedCount >= lineLimit || selectedBytes + bytes > REMOTE_AGENT_TEXT_MAX_BYTES) {
      if (selectedCount === 0) selected.push(boundedLine(rendered, REMOTE_AGENT_TEXT_MAX_BYTES))
      stoppedByBudget = true
      return false
    }
    if (previousSelectedLine !== undefined && lineNumber > previousSelectedLine + 1) {
      selected.push('…')
    }
    selected.push(rendered)
    selectedBytes += bytes
    selectedCount += 1
    previousSelectedLine = lineNumber
    return true
  }

  const finishLine = (line: string, forcedTruncation = false): boolean => {
    if (!keepLine(line, forcedTruncation)) return false
    lineNumber += 1
    if (lineNumber > maxLine && selector?.tail === undefined) {
      stoppedByRange = true
      if (!scanPastRange) {
        stoppedEarlyByRange = true
        return false
      }
    }
    return true
  }

  scan: while (offset < snapshot.size) {
    const length = Math.min(SCAN_CHUNK_BYTES, snapshot.size - offset)
    const bytes = await readRemoteWorkspaceFileRange(
      session,
      target.path,
      target.canonicalRoot,
      snapshot,
      offset,
      length
    )
    if (bytes.length === 0) throw new Error('远程文件在读取期间发生变化')
    if (bytes.includes(0)) return { content: '', truncated: false, binary: true }
    offset += bytes.length
    let decoded: string
    try {
      decoded = decoder.decode(bytes, { stream: offset < snapshot.size })
    } catch {
      return { content: '', truncated: false, binary: true }
    }
    endedWithNewline = decoded.endsWith('\n')

    let cursor = 0
    while (cursor < decoded.length) {
      if (discardingLine) {
        const newline = decoded.indexOf('\n', cursor)
        if (newline < 0) break
        if (selector?.tail !== undefined && !finishLine(discardedTailPrefix, true)) break scan
        if (selector?.tail === undefined) {
          lineNumber += 1
          if (lineNumber > maxLine) {
            stoppedByRange = true
            if (!scanPastRange) {
              stoppedEarlyByRange = true
              break scan
            }
          }
        }
        discardingLine = false
        discardedTailPrefix = ''
        cursor = newline + 1
        continue
      }

      const newline = decoded.indexOf('\n', cursor)
      if (newline >= 0) {
        const line = pending + decoded.slice(cursor, newline)
        pending = ''
        if (!finishLine(line)) break scan
        cursor = newline + 1
        continue
      }

      pending += decoded.slice(cursor)
      const pendingBytes = Buffer.byteLength(pending, 'utf8')
      const pendingLimit =
        selector?.tail !== undefined ? tailLineBytes : REMOTE_AGENT_TEXT_MAX_BYTES
      if (pendingBytes > pendingLimit) {
        if (selector?.tail !== undefined) {
          discardedTailPrefix = boundedLine(pending, tailLineBytes).replace(/…$/, '')
        } else if (selectedBy(displaySelector, lineNumber)) {
          selected.push(boundedLine(renderLine(pending), REMOTE_AGENT_TEXT_MAX_BYTES))
          stoppedByBudget = true
          break scan
        }
        pending = ''
        discardingLine = true
      }
      break
    }
  }

  if (!stoppedByBudget && !stoppedEarlyByRange && offset >= snapshot.size) {
    if (discardingLine) {
      if (selector?.tail !== undefined) finishLine(discardedTailPrefix, true)
    } else if (pending.length > 0) {
      finishLine(pending)
    } else if (selector?.raw && endedWithNewline) {
      finishLine('')
    }
  }

  const lines = selector?.tail !== undefined ? tailLines.map((line) => line.text) : selected
  const tailTruncated = tailLines.some((line) => line.truncated)
  const totalLines = Math.max(0, lineNumber - 1)
  const notices =
    offset >= snapshot.size && selector?.ranges
      ? selector.ranges
          .filter((range) => range.start > totalLines)
          .map((range) => {
            const bound = range.end === undefined ? `${range.start}` : `${range.start}-${range.end}`
            return `[Range ${bound} is beyond end of file (${totalLines} lines total); skipped]`
          })
      : []
  const singleRange = !selector?.ranges || selector.ranges.length === 1
  const needsContinuation =
    selector?.tail === undefined && singleRange && (stoppedByBudget || stoppedByRange)
  const nextLine = Number.isFinite(maxLine) ? maxLine + 1 : lineNumber
  const continuation = needsContinuation
    ? offset >= snapshot.size && Number.isFinite(maxLine)
      ? `[${Math.max(0, totalLines - maxLine)} more lines in file. Use :${nextLine} to continue]`
      : `[More lines in file (${snapshot.size} bytes total; not scanned to EOF). Use :${nextLine} to continue]`
    : undefined
  const tailNotice = tailTruncated
    ? '[Tail output was truncated to fit the 50 KiB read limit. Use a narrower :-N selector or bash tail for the complete line.]'
    : undefined
  const truncated =
    stoppedByBudget || offset < snapshot.size || Boolean(continuation) || tailTruncated
  const sections = [lines.join('\n'), ...notices, continuation, tailNotice].filter(
    (value): value is string => Boolean(value)
  )
  return {
    content: sections.join('\n\n'),
    truncated,
    ...(continuation || tailNotice ? { continuation: continuation ?? tailNotice } : {})
  }
}
