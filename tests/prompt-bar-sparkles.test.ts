import assert from 'node:assert/strict'
import test from 'node:test'
import { SparkAnimation } from '../src/renderer/src/components/chat/PromptBarSparkles'

type Arc = { x: number; y: number; radius: number }

test('spark drift stays smooth and never accelerates', () => {
  const frames: Arc[][] = []
  let current: Arc[] = []
  const context = {
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    globalAlpha: 1,
    setTransform: (): void => undefined,
    clearRect(): void {
      current = []
      frames.push(current)
    },
    beginPath: (): void => undefined,
    arc(x: number, y: number, radius: number): void {
      current.push({ x, y, radius })
    },
    fill: (): void => undefined
  }
  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 1200, height: 130 })
  }
  let rafCallback: ((now: number) => void) | null = null
  Object.assign(globalThis, {
    window: { devicePixelRatio: 1 },
    ResizeObserver: class {
      observe = (): void => undefined
      disconnect = (): void => undefined
    },
    requestAnimationFrame: (callback: (now: number) => void): number => {
      rafCallback = callback
      return 1
    },
    cancelAnimationFrame: (): void => undefined
  })

  const animation = new SparkAnimation(
    canvas as unknown as HTMLCanvasElement,
    context as unknown as CanvasRenderingContext2D
  )
  const stop = animation.start()
  // Absolute timestamps must be large: a phase bug that scales wall-clock time
  // by a varying rate only explodes once performance.now() is big.
  let now = 600_000
  const step = (): void => {
    now += 16.7
    const callback = rafCallback
    rafCallback = null
    callback?.(now)
  }
  for (let index = 0; index < 10; index += 1) step()
  const measuredFrom = frames.length
  for (let index = 0; index < 40; index += 1) step()
  stop()

  let matched = 0
  let maxJump = 0
  let maxRise = 0
  for (let frame = measuredFrom + 1; frame < frames.length; frame += 1) {
    for (const previous of frames[frame - 1]) {
      // Sparks only move up; respawns and fresh spawns jump down, so a single
      // candidate slightly above the previous position is the same spark.
      const candidates = frames[frame].filter((next) => {
        const dy = next.y - previous.y
        return dy <= 0.01 && dy > -3
      })
      if (candidates.length !== 1) continue
      matched += 1
      maxJump = Math.max(maxJump, Math.abs(candidates[0].x - previous.x))
      maxRise = Math.max(maxRise, previous.y - candidates[0].y)
    }
  }
  assert.ok(matched > 100, `expected enough tracked sparks, got ${matched}`)
  assert.ok(maxJump < 1.5, `spark x jumped ${maxJump.toFixed(2)}px between consecutive frames`)
  // Ambient drift tops out at 16px/s (~0.27px per frame); any typing-driven
  // acceleration would push a frame's rise well past this.
  assert.ok(maxRise < 0.3, `spark rose ${maxRise.toFixed(2)}px in one frame`)
})
