import { loadOfficePreviewHtml } from './office-docx-preview-check'
import type { OfficePreviewConfirmation } from './office-write-contract'

interface DocumentTextWaiter {
  readonly expectedText: string
  readonly previewUrl: string
  readonly baselineVersion: number
  readonly resolve: (confirmed: boolean) => void
  readonly timer: NodeJS.Timeout
  writeDispatched: boolean
  checking: boolean
}

export class OfficeDocumentTextConfirmationManager {
  private readonly waiters = new Map<string, Set<DocumentTextWaiter>>()
  private readonly versions = new Map<string, number>()

  constructor(
    private readonly timeoutMs: number,
    private readonly loadHtml: (url: string) => Promise<string> = loadOfficePreviewHtml
  ) {}

  establishBaseline(artifactId: string, version: number): void {
    this.versions.set(artifactId, version)
  }

  arm(artifactId: string, previewUrl: string, expectedText: string): OfficePreviewConfirmation {
    const baselineVersion = this.versions.get(artifactId)
    if (baselineVersion === undefined) return unavailableConfirmation()
    let waiter: DocumentTextWaiter
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(artifactId, waiter, false), this.timeoutMs)
      timer.unref()
      waiter = {
        expectedText,
        previewUrl,
        baselineVersion,
        resolve,
        timer,
        writeDispatched: false,
        checking: false
      }
      const waiters = this.waiters.get(artifactId) ?? new Set<DocumentTextWaiter>()
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

  publish(artifactId: string, version: number): void {
    this.versions.set(artifactId, version)
    void this.confirm(artifactId, version)
  }

  clear(artifactId: string): void {
    for (const waiter of [...(this.waiters.get(artifactId) ?? [])]) {
      this.settle(artifactId, waiter, false)
    }
    this.versions.delete(artifactId)
  }

  private async confirm(artifactId: string, version: number): Promise<void> {
    for (const waiter of [...(this.waiters.get(artifactId) ?? [])]) {
      if (!eligible(waiter, version)) continue
      waiter.checking = true
      const html = await this.loadHtml(waiter.previewUrl).catch(() => '')
      waiter.checking = false
      if (previewHtmlHasText(html, waiter.expectedText)) this.settle(artifactId, waiter, true)
    }
  }

  private settle(artifactId: string, waiter: DocumentTextWaiter, confirmed: boolean): void {
    const waiters = this.waiters.get(artifactId)
    if (!waiters?.delete(waiter)) return
    clearTimeout(waiter.timer)
    if (waiters.size === 0) this.waiters.delete(artifactId)
    waiter.resolve(confirmed)
  }
}

function eligible(waiter: DocumentTextWaiter, version: number): boolean {
  return waiter.writeDispatched && !waiter.checking && version > waiter.baselineVersion
}

function previewHtmlHasText(html: string, text: string): boolean {
  const expected = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return Boolean(expected) && html.includes(expected)
}

function unavailableConfirmation(): OfficePreviewConfirmation {
  return { promise: Promise.resolve(false), cancel: () => undefined }
}
