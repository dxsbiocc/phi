import assert from 'node:assert/strict'
import { setImmediate as defer } from 'node:timers/promises'
import test from 'node:test'

import { OfficePreviewProcessManager } from '../src/main/agent/office/office-watch'

test('PPTX add confirmation waits until the refreshed slide count is published', async () => {
  const harness = createHarness()
  await harness.manager.start('/officecli', artifact)
  const confirmation = harness.manager.armDocumentTextConfirmation(artifact.artifactId, '新增标题')
  confirmation.markDispatched?.()
  harness.showPage('新增标题')
  harness.publishChange(1, true)
  assert.equal(await pendingState(confirmation.promise), 'pending')
  assert.deepEqual(harness.slideCounts, [])

  harness.resolveSlideCount(1)
  assert.equal(await confirmation.promise, true)
  assert.deepEqual(harness.slideCounts, [1])
  await harness.manager.stop(artifact)
})

const artifact = {
  artifactId: 'artifact-pptx-count-confirm',
  sessionId: 'session-1',
  projectId: null,
  kind: 'pptx' as const,
  origin: 'blank' as const,
  sourcePath: null,
  sourceHash: null,
  draftPath: '/sessions/session-1/artifacts/office/count-confirm/deck.pptx'
}

function createHarness(): {
  readonly manager: OfficePreviewProcessManager
  readonly slideCounts: number[]
  readonly publishChange: (version: number, slideCountChanged: boolean) => void
  readonly resolveSlideCount: (value: number) => void
  readonly showPage: (title: string) => void
} {
  let publishChange: ((version: number, slideCountChanged: boolean) => void) | undefined
  let html = zeroPageHtml()
  let inspections = 0
  const slideCounts: number[] = []
  const pendingCount = deferredNumber()
  const manager = new OfficePreviewProcessManager(
    {
      availablePort: async () => 31_015,
      startWatch: async (binaryPath, inputArtifact, port) => ({
        artifact: inputArtifact,
        binaryPath,
        pid: 215,
        port,
        stop: async () => undefined
      }),
      startGateway: async (input) => {
        publishChange = input.onPresentationChange
        return {
          artifactId: input.artifactId,
          port: 42_015,
          url: 'http://127.0.0.1:42015/',
          close: async () => undefined
        }
      },
      inspectPptxPreview: async () => (inspections++ === 0 ? 0 : pendingCount.promise),
      loadPreviewHtml: async () => html,
      previewConfirmationTimeoutMs: 1_000
    },
    () => undefined,
    { apply: async () => undefined, access: () => 'read_only', rejected: () => undefined },
    (_artifactId, slideCount) => slideCounts.push(slideCount)
  )
  return {
    manager,
    slideCounts,
    publishChange: (version, changed) => publishChange?.(version, changed),
    resolveSlideCount: pendingCount.resolve,
    showPage: (title) => {
      html = onePageHtml(title)
    }
  }
}

function deferredNumber(): {
  readonly promise: Promise<number>
  readonly resolve: (value: number) => void
} {
  let resolve!: (value: number) => void
  const promise = new Promise<number>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function pendingState(promise: Promise<boolean>): Promise<'confirmed' | 'pending'> {
  return Promise.race([
    promise.then(() => 'confirmed' as const),
    defer().then(() => 'pending' as const)
  ])
}

function zeroPageHtml(): string {
  return '<html><body><div class="main"></div><div class="page-counter">1 / 0</div></body></html>'
}

function onePageHtml(title: string): string {
  return `<html><body><div class="main"><div class="slide-container">${title}</div></div><div class="thumb"></div><div class="page-counter">1 / 1</div></body></html>`
}
