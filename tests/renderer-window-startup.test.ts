import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

interface RendererFixture {
  root: { children: Array<{ tagName: string; backgroundColor: string }> }
  signals: string[]
  frames: FrameRequestCallback[]
  fontsReady: () => void
  content: () => void
  mutate: () => void
  isDisconnected: () => boolean
  sync: (color: string) => void
}

function rendererFixture(elementColor: string): RendererFixture {
  const frames: FrameRequestCallback[] = []
  const signals: string[] = []
  const root = { children: [] as Array<{ tagName: string; backgroundColor: string }> }
  let mutation = (): void => undefined
  let disconnected = false
  let fontsReady!: () => void
  const document = {
    body: { backgroundColor: 'rgb(13, 18, 24)' },
    fonts: { ready: new Promise<void>((resolve) => (fontsReady = resolve)) }
  }
  class Observer {
    constructor(callback: () => void) {
      mutation = callback
    }
    observe(): void {
      return undefined
    }
    disconnect(): void {
      disconnected = true
    }
  }
  const source = readFileSync('src/renderer/src/lib/windowStartup.ts', 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {} as {
    observeWindowFirstFrame: (root: unknown) => void
    syncWindowBackground: (color: string) => void
  }
  new Function(
    'exports',
    'window',
    'document',
    'MutationObserver',
    'requestAnimationFrame',
    'getComputedStyle',
    code
  )(
    exports,
    { api: { readyWindow: async (color: string) => signals.push(color) } },
    document,
    Observer,
    (callback: FrameRequestCallback) => frames.push(callback),
    (element: { backgroundColor: string }) => element
  )
  exports.observeWindowFirstFrame(root)
  return {
    root,
    signals,
    frames,
    fontsReady,
    content: () => {
      root.children.push({ tagName: 'DIV', backgroundColor: elementColor })
      mutation()
    },
    mutate: () => mutation(),
    isDisconnected: () => disconnected,
    sync: exports.syncWindowBackground
  }
}

test('HTML/styles alone cannot signal ready; committed content, fonts and two frames are required', async () => {
  const fixture = rendererFixture('rgba(0, 0, 0, 0)')
  fixture.root.children.push({ tagName: 'STYLE', backgroundColor: 'transparent' })
  fixture.mutate()
  fixture.sync('#FFFFFF')
  assert.equal(fixture.frames.length, 0)
  assert.deepEqual(fixture.signals, [])
  fixture.content()
  await Promise.resolve()
  assert.equal(fixture.frames.length, 0, 'wait for the font used by the first frame')
  fixture.fontsReady()
  await Promise.resolve()
  assert.equal(fixture.frames.length, 1)
  fixture.frames.shift()!(0)
  assert.deepEqual(fixture.signals, [])
  fixture.frames.shift()!(16)
  assert.deepEqual(fixture.signals, ['rgb(13, 18, 24)'])
  assert.equal(fixture.isDisconnected(), true)
  fixture.sync('#FFFFFF')
  assert.deepEqual(fixture.signals, ['rgb(13, 18, 24)', '#FFFFFF'])
})

test('a committed error fallback can reveal its own background before App mounts', async () => {
  const fixture = rendererFixture('rgb(11, 38, 45)')
  fixture.content()
  fixture.fontsReady()
  await Promise.resolve()
  fixture.frames.shift()!(0)
  fixture.frames.shift()!(16)
  assert.deepEqual(fixture.signals, ['rgb(11, 38, 45)'])
})

test('content removed before painting never causes an empty window to be revealed', async () => {
  const fixture = rendererFixture('rgb(13, 18, 24)')
  fixture.content()
  fixture.fontsReady()
  await Promise.resolve()
  fixture.frames.shift()!(0)
  fixture.root.children = []
  fixture.frames.shift()!(16)
  assert.deepEqual(fixture.signals, [])
  assert.equal(fixture.isDisconnected(), false)
  fixture.content()
  await Promise.resolve()
  fixture.frames.shift()!(32)
  fixture.frames.shift()!(48)
  assert.deepEqual(fixture.signals, ['rgb(13, 18, 24)'])
})
