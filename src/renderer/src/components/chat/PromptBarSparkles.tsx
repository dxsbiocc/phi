import { useEffect, useRef, useState } from 'react'

// Adapted from React Bits PromptBar (TS-TW): https://reactbits.dev/micro/prompt-bar
// Keep the effect separate from the editor so changing effort never remounts the draft.
type Spark = {
  x: number
  y: number
  radius: number
  velocity: number
  sway: number
  phase: number
  life: number
  span: number
}

const SPARK_COLOR = '#b39dff'

type TypingState = {
  energy: number
  strokes: number
  value: string
}

class SparkAnimation {
  private frame = 0
  private last = performance.now()
  private width = 0
  private height = 0
  private due = 0
  private speed = 1
  private pulse = 0
  private readonly sparks: Spark[] = []

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
    private readonly typing: { current: TypingState }
  ) {}

  start(): () => void {
    this.typing.current.strokes = 0
    this.resize()
    for (let index = 0; index < 26; index += 1) this.spawn(true)
    const observer = new ResizeObserver(this.resize)
    observer.observe(this.canvas)
    this.frame = requestAnimationFrame(this.tick)
    return () => {
      cancelAnimationFrame(this.frame)
      observer.disconnect()
      this.context.clearRect(0, 0, this.width, this.height)
    }
  }

  private readonly resize = (): void => {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this.width = rect.width
    this.height = rect.height
    this.canvas.width = Math.round(this.width * dpr)
    this.canvas.height = Math.round(this.height * dpr)
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private spawn(burst: boolean): void {
    this.sparks.push({
      x: Math.random() * this.width,
      y: burst ? this.height * (0.2 + Math.random() * 0.8) : this.height + 3,
      radius: 0.9 + Math.random() * 1.1,
      velocity: -(7 + Math.random() * 9),
      sway: (Math.random() - 0.5) * 10,
      phase: Math.random() * Math.PI * 2,
      life: burst ? Math.random() * 1.2 : 0,
      span: 2.4 + Math.random() * 2.4
    })
  }

  private readonly tick = (now: number): void => {
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    const typed = this.typing.current
    typed.energy *= Math.exp(-dt / 0.8)
    this.pulse *= Math.exp(-dt / 0.16)
    if (typed.strokes > 0) {
      typed.strokes = 0
      this.pulse = 1
    }
    const energy = typed.energy
    this.speed += (1 + energy * 6 - this.speed) * (1 - Math.exp(-dt / 0.15))
    this.due += dt
    while (this.due > 0.14) {
      this.due -= 0.14
      if (this.sparks.length < 30) this.spawn(false)
    }
    this.drawSparks(now, dt, energy)
    this.frame = requestAnimationFrame(this.tick)
  }

  private drawSparks(now: number, dt: number, energy: number): void {
    this.context.clearRect(0, 0, this.width, this.height)
    this.context.fillStyle = SPARK_COLOR
    this.context.shadowColor = SPARK_COLOR
    this.context.shadowBlur = 6 + energy * 10 + this.pulse * 6
    for (let index = this.sparks.length - 1; index >= 0; index -= 1) {
      const spark = this.sparks[index]
      spark.life += dt
      if (spark.life > spark.span) {
        this.sparks.splice(index, 1)
        continue
      }
      this.drawSpark(spark, now, dt, energy)
    }
    this.context.globalAlpha = 1
  }

  private drawSpark(spark: Spark, now: number, dt: number, energy: number): void {
    const progress = spark.life / spark.span
    const twinkle = 0.7 + 0.3 * Math.sin((now / 160) * (1 + energy) + spark.phase)
    spark.y += spark.velocity * dt * this.speed
    if (spark.y < -4) {
      spark.y = this.height + 3
      spark.x = Math.random() * this.width
    }
    const edge = Math.min(1, Math.max(0, spark.y / 14), Math.max(0, (this.height - spark.y) / 14))
    this.context.globalAlpha =
      Math.min(1, Math.sin(progress * Math.PI) * (0.9 + energy * 0.25) * twinkle) * edge
    this.context.beginPath()
    this.context.arc(
      spark.x + Math.sin((now / 900) * (1 + energy * 0.8) + spark.phase) * spark.sway,
      spark.y,
      spark.radius * twinkle * (1 + energy * 0.35),
      0,
      Math.PI * 2
    )
    this.context.fill()
  }
}

export function PromptBarSparkles({
  active,
  value
}: {
  active: boolean
  value: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const typing = useRef({ energy: 0, strokes: 0, value })
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (value !== typing.current.value) {
      if (active) {
        typing.current.strokes += 1
        typing.current.energy = Math.min(1, typing.current.energy + 0.35)
      }
      typing.current.value = value
    }
  }, [active, value])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!active || reducedMotion || !canvas) return undefined
    const context = canvas.getContext('2d')
    if (!context) return undefined
    return new SparkAnimation(canvas, context, typing).start()
  }, [active, reducedMotion])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-phi-prompt-bar-sparkles={active && !reducedMotion ? 'active' : 'inactive'}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        borderRadius: 'inherit',
        zIndex: 0
      }}
    />
  )
}
