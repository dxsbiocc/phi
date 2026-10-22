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

    typing.current.strokes = 0
    let frame = 0
    let last = performance.now()
    let width = 0
    let height = 0
    let due = 0
    let speed = 1
    let pulse = 0
    const sparks: Spark[] = []

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const spawn = (burst: boolean): void => {
      sparks.push({
        x: Math.random() * width,
        y: burst ? height * (0.2 + Math.random() * 0.8) : height + 3,
        radius: 0.9 + Math.random() * 1.1,
        velocity: -(7 + Math.random() * 9),
        sway: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        life: burst ? Math.random() * 1.2 : 0,
        span: 2.4 + Math.random() * 2.4
      })
    }

    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const typed = typing.current
      typed.energy *= Math.exp(-dt / 0.8)
      pulse *= Math.exp(-dt / 0.16)
      if (typed.strokes > 0) {
        typed.strokes = 0
        pulse = 1
      }
      const energy = typed.energy
      speed += (1 + energy * 6 - speed) * (1 - Math.exp(-dt / 0.15))
      due += dt
      while (due > 0.14) {
        due -= 0.14
        if (sparks.length < 30) spawn(false)
      }
      context.clearRect(0, 0, width, height)
      context.fillStyle = SPARK_COLOR
      context.shadowColor = SPARK_COLOR
      context.shadowBlur = 6 + energy * 10 + pulse * 6
      for (let index = sparks.length - 1; index >= 0; index -= 1) {
        const spark = sparks[index]
        spark.life += dt
        if (spark.life > spark.span) {
          sparks.splice(index, 1)
          continue
        }
        const progress = spark.life / spark.span
        const twinkle = 0.7 + 0.3 * Math.sin((now / 160) * (1 + energy) + spark.phase)
        spark.y += spark.velocity * dt * speed
        if (spark.y < -4) {
          spark.y = height + 3
          spark.x = Math.random() * width
        }
        const edge = Math.min(1, Math.max(0, spark.y / 14), Math.max(0, (height - spark.y) / 14))
        context.globalAlpha =
          Math.min(1, Math.sin(progress * Math.PI) * (0.9 + energy * 0.25) * twinkle) * edge
        context.beginPath()
        context.arc(
          spark.x + Math.sin((now / 900) * (1 + energy * 0.8) + spark.phase) * spark.sway,
          spark.y,
          spark.radius * twinkle * (1 + energy * 0.35),
          0,
          Math.PI * 2
        )
        context.fill()
      }
      context.globalAlpha = 1
      frame = requestAnimationFrame(tick)
    }

    resize()
    for (let index = 0; index < 26; index += 1) spawn(true)
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      context.clearRect(0, 0, width, height)
    }
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
