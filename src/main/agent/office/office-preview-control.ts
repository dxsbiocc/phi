import type { ServerResponse } from 'node:http'

import { type OfficeHighlightTarget, parseOfficeHighlightRange } from './office-highlight'
import { validOfficeSheetName } from './office-read-contract'

export const OFFICE_PREVIEW_CONTROL_PATH = '/__phi/preview-events'
export const OFFICE_HIGHLIGHT_DURATION_MS = 9_000
export const OFFICE_HIGHLIGHT_EVENT = 'phi-ai-highlight'
export const OFFICE_HIGHLIGHT_FOLLOW_EVENT = 'phi-ai-highlight-follow'
export const OFFICE_SHEET_HIGHLIGHT_EVENT = 'phi-ai-sheet-highlight'
export const OFFICE_SHEET_HIGHLIGHT_FOLLOW_EVENT = 'phi-ai-sheet-highlight-follow'

export class OfficePreviewControlChannel {
  private readonly clients = new Set<ServerResponse>()

  constructor(private readonly enabled: boolean) {}

  connect(response: ServerResponse, headers: Readonly<Record<string, string>>): boolean {
    if (!this.enabled) return false
    response.writeHead(200, headers)
    response.write(': connected\n\n')
    this.clients.add(response)
    response.once('close', () => this.clients.delete(response))
    return true
  }

  publish(target: OfficeHighlightTarget, follow: boolean): boolean {
    if (!this.enabled) return false
    const normalized = checkedTarget(target)
    const event = target.range
      ? follow
        ? OFFICE_HIGHLIGHT_FOLLOW_EVENT
        : OFFICE_HIGHLIGHT_EVENT
      : follow
        ? OFFICE_SHEET_HIGHLIGHT_FOLLOW_EVENT
        : OFFICE_SHEET_HIGHLIGHT_EVENT
    const frame = `event: ${event}\ndata: ${JSON.stringify(normalized)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(frame)
      } catch {
        this.clients.delete(client)
      }
    }
    return true
  }

  close(): void {
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        // A destroyed preview subscriber must not block gateway cleanup.
      }
    }
    this.clients.clear()
  }
}

function checkedTarget(target: OfficeHighlightTarget): OfficeHighlightTarget {
  if (
    !target ||
    typeof target !== 'object' ||
    Object.keys(target).some((key) => key !== 'sheet' && key !== 'range') ||
    typeof target.sheet !== 'string' ||
    !validOfficeSheetName(target.sheet) ||
    (target.range !== undefined && typeof target.range !== 'string')
  ) {
    throw new Error('Office 高亮目标无效')
  }
  return target.range === undefined
    ? Object.freeze({ sheet: target.sheet })
    : Object.freeze({ sheet: target.sheet, range: parseOfficeHighlightRange(target.range).range })
}
