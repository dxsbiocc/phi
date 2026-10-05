import { get as getHttp } from 'node:http'

import type { OfficePreviewConfirmation } from './office-write-contract'

interface SheetTabWaiter {
  readonly sheet: string
  readonly previewUrl: string
  readonly resolve: (confirmed: boolean) => void
  readonly timer: NodeJS.Timeout
  writeDispatched: boolean
  checking: boolean
  readonly baselineFullVersion?: number
}

export class OfficeSheetTabConfirmationManager {
  private readonly waiters = new Map<string, Set<SheetTabWaiter>>()
  private readonly fullVersions = new Map<string, number>()

  constructor(
    private readonly timeoutMs: number,
    private readonly loadPreviewHtml: (url: string) => Promise<string> = readPreviewHtml
  ) {}

  arm(artifactId: string, previewUrl: string, sheet: string): OfficePreviewConfirmation {
    let waiter: SheetTabWaiter
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(artifactId, waiter, false), this.timeoutMs)
      timer.unref()
      waiter = {
        sheet,
        previewUrl,
        resolve,
        timer,
        writeDispatched: false,
        checking: false,
        baselineFullVersion: this.fullVersions.get(artifactId)
      }
      const waiters = this.waiters.get(artifactId) ?? new Set<SheetTabWaiter>()
      waiters.add(waiter)
      this.waiters.set(artifactId, waiters)
    })
    return {
      promise,
      cancel: () => this.settle(artifactId, waiter, false),
      markDispatched: () => {
        waiter.writeDispatched = true
      }
    }
  }

  publishFull(artifactId: string, version: number): void {
    this.fullVersions.set(artifactId, version)
    void this.confirm(artifactId, version)
  }

  clear(artifactId: string): void {
    const waiters = this.waiters.get(artifactId)
    if (waiters) {
      for (const waiter of [...waiters]) this.settle(artifactId, waiter, false)
    }
    this.fullVersions.delete(artifactId)
  }

  private async confirm(artifactId: string, version: number): Promise<void> {
    const waiters = this.waiters.get(artifactId)
    if (!waiters) return
    for (const waiter of [...waiters]) {
      if (!eligible(waiter, version)) continue
      waiter.checking = true
      const html = await this.loadPreviewHtml(waiter.previewUrl).catch(() => '')
      waiter.checking = false
      if (previewHtmlHasSheetTab(html, waiter.sheet)) {
        this.settle(artifactId, waiter, true)
        continue
      }
      const latest = this.fullVersions.get(artifactId)
      if (latest !== undefined && latest > version) void this.confirm(artifactId, latest)
    }
  }

  private settle(artifactId: string, waiter: SheetTabWaiter, confirmed: boolean): void {
    const waiters = this.waiters.get(artifactId)
    if (!waiters?.delete(waiter)) return
    clearTimeout(waiter.timer)
    if (waiters.size === 0) this.waiters.delete(artifactId)
    waiter.resolve(confirmed)
  }
}

function eligible(waiter: SheetTabWaiter, version: number): boolean {
  return (
    !waiter.checking &&
    waiter.writeDispatched &&
    waiter.baselineFullVersion !== undefined &&
    version > waiter.baselineFullVersion
  )
}

export function previewHtmlHasSheetTab(html: string, sheet: string): boolean {
  const expected = escapeHtmlText(sheet)
  return [
    ...html.matchAll(/<div class="sheet-tab(?: active)?"[^>]*role="tab"[^>]*>([^<]*)<\/div>/gu)
  ].some((match) => match[1] === expected)
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function readPreviewHtml(url: string): Promise<string> {
  return new Promise((resolve) => {
    const request = getHttp(url, (response) => {
      let body = ''
      let oversized = false
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        if (Buffer.byteLength(body, 'utf8') + Buffer.byteLength(chunk, 'utf8') > 8 * 1024 * 1024) {
          oversized = true
        } else if (!oversized) body += chunk
      })
      response.once('end', () =>
        resolve(!oversized && (response.statusCode ?? 500) < 400 ? body : '')
      )
    })
    request.setTimeout(1_000, () => request.destroy())
    request.once('error', () => resolve(''))
  })
}
