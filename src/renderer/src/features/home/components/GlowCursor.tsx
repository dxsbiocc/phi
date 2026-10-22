/* eslint-disable @typescript-eslint/explicit-function-return-type, max-lines, max-lines-per-function, max-params, complexity -- Vendored React Bits WebGL lifecycle stays together for upstream parity. */
'use client'

import { useEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'

import './GlowCursor.css'
import {
  VERTEX,
  SPLAT,
  ADVECT,
  MACCORMACK,
  DIVERGENCE,
  SCALE,
  PRESSURE,
  GRADIENT,
  PREFILTER,
  DOWN,
  UP,
  DISPLAY
} from '../lib/glowCursorShaders'

// Source: https://reactbits.dev/r/GlowCursor-TS-CSS.json
// Keep the upstream WebGL lifecycle together; shader strings live in the home feature library.

export interface GlowCursorProps extends Omit<HTMLAttributes<HTMLDivElement>, 'color'> {
  color?: string
  secondaryColor?: string
  intensity?: number
  trailWidth?: number
  linger?: number
  glow?: number
  hotspot?: number
  followSpeed?: number
  grain?: number
  clickBurst?: boolean
  quality?: 'low' | 'medium' | 'high'
  theme?: 'dark' | 'light'
  blendMode?: CSSProperties['mixBlendMode']
  maxDevicePixelRatio?: number
  enabled?: boolean
  children?: ReactNode
}

type Quality = 'low' | 'medium' | 'high'

type Settings = {
  color: string
  secondaryColor: string
  intensity: number
  trailWidth: number
  linger: number
  glow: number
  hotspot: number
  followSpeed: number
  grain: number
  clickBurst: boolean
  quality: Quality
  theme: 'dark' | 'light'
  maxDevicePixelRatio: number
  enabled: boolean
}

type Target = {
  texture: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
  texel: [number, number]
}

type Pair = {
  readonly read: Target
  readonly write: Target
  swap: () => void
  targets: () => Target[]
}

type Targets = {
  velocity: Pair
  dye: Pair
  forward: Target
  back: Target
  pressure: Pair
  divergence: Target
  bloom: Target[]
}

type Pass = {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

const QUALITY: Record<Quality, { sim: number; dye: number }> = {
  low: { sim: 96, dye: 384 },
  medium: { sim: 128, dye: 576 },
  high: { sim: 160, dye: 768 }
}

const PRESSURE_STEPS = 20
const FLOW = 0.75
const BLOOM_LEVELS = 5

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const compile = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return null
}

const toHsv = ([r, g, b]: number[]): [number, number, number] => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let hue = 0
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
  }
  return [(hue * 60 + 360) % 360, max > 0 ? delta / max : 0, max]
}

const fromHsv = (hue: number, saturation: number, value: number): number[] => {
  const h = (((hue % 360) + 360) % 360) / 60
  const c = value * saturation
  const x = c * (1 - Math.abs((h % 2) - 1))
  const m = value - c
  const [r, g, b] =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x]
  return [r + m, g + m, b + m]
}

const GlowCursor = ({
  color = '#5f8bff',
  secondaryColor,
  intensity = 1.3,
  trailWidth = 3,
  linger = 1.4,
  glow = 1.2,
  hotspot = 0.8,
  followSpeed = 0.6,
  grain = 0,
  clickBurst = true,
  quality = 'high',
  theme = 'dark',
  blendMode,
  maxDevicePixelRatio = 2,
  enabled = true,
  children,
  className = '',
  style,
  ...rest
}: GlowCursorProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const settingsRef = useRef<Settings>(null as unknown as Settings)
  useEffect(() => {
    settingsRef.current = {
      color: String(color),
      secondaryColor: secondaryColor ? String(secondaryColor) : '',
      intensity: Math.max(0, intensity),
      trailWidth: clamp(trailWidth, 0.5, 40),
      linger: clamp(linger, 0.1, 10),
      glow: Math.max(0, glow),
      hotspot: Math.max(0, hotspot),
      followSpeed: clamp(followSpeed, 0, 1),
      grain: Math.max(0, grain),
      clickBurst,
      quality: (QUALITY as Record<string, unknown>)[quality] ? quality : 'high',
      theme,
      maxDevicePixelRatio,
      enabled
    }
  })

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    const gl = canvas?.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false
    })
    if (!container || !canvas || !gl || !gl.getExtension('EXT_color_buffer_float')) return undefined

    const vertexShader = compile(gl, gl.VERTEX_SHADER, VERTEX)
    if (!vertexShader) return undefined

    const build = (source: string): Pass | null => {
      const fragment = compile(gl, gl.FRAGMENT_SHADER, source)
      const program = gl.createProgram()
      if (!fragment || !program) return null
      gl.attachShader(program, vertexShader)
      gl.attachShader(program, fragment)
      gl.bindAttribLocation(program, 0, 'aPosition')
      gl.linkProgram(program)
      gl.deleteShader(fragment)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program)
        return null
      }
      const uniforms: Record<string, WebGLUniformLocation | null> = {}
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i)
        if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name)
      }
      return { program, uniforms }
    }

    const passes = {
      splat: build(SPLAT),
      advect: build(ADVECT),
      maccormack: build(MACCORMACK),
      divergence: build(DIVERGENCE),
      scale: build(SCALE),
      pressure: build(PRESSURE),
      gradient: build(GRADIENT),
      prefilter: build(PREFILTER),
      down: build(DOWN),
      up: build(UP),
      display: build(DISPLAY)
    }
    if (Object.values(passes).some((pass) => !pass)) return undefined
    const pass = passes as Record<keyof typeof passes, Pass>

    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    const probeContext = probe.getContext('2d', { willReadFrequently: true })
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    const state = {
      width: 1,
      height: 1,
      ratio: 1,
      colorKey: '',
      color: [0.37, 0.55, 1] as number[],
      secondary: [0.25, 0.3, 1] as number[],
      pointer: { x: 0, y: 0, inside: false },
      emitter: { x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0, travelled: 0 },
      ready: false,
      bursts: [] as [number, number][],
      active: -Infinity,
      time: 0,
      allocated: '',
      targets: null as Targets | null
    }
    let raf = 0
    let last = 0
    let alive = true
    let visible = true

    const toRgb = (value: string, fallback: number[]): number[] => {
      if (!probeContext || !value) return fallback
      const css = /^[0-9a-f]{3,8}$/i.test(value) ? `#${value}` : value
      probeContext.clearRect(0, 0, 1, 1)
      probeContext.fillStyle = '#000000'
      probeContext.fillStyle = css
      probeContext.fillRect(0, 0, 1, 1)
      const [r, g, b] = probeContext.getImageData(0, 0, 1, 1).data
      return [r / 255, g / 255, b / 255]
    }

    const resolveColors = (s: Settings) => {
      const key = `${s.color}|${s.secondaryColor}`
      if (key === state.colorKey) return
      state.colorKey = key
      state.color = toRgb(s.color, [0.37, 0.55, 1])
      if (s.secondaryColor) {
        state.secondary = toRgb(s.secondaryColor, state.color)
      } else {
        const [hue, saturation, value] = toHsv(state.color)
        state.secondary = fromHsv(hue + 8, Math.min(1, saturation * 1.1 + 0.05), value)
      }
    }

    const createTarget = (
      width: number,
      height: number,
      internalFormat: number,
      format: number,
      filter: number
    ): Target => {
      const texture = gl.createTexture() as WebGLTexture
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.HALF_FLOAT, null)
      const fbo = gl.createFramebuffer() as WebGLFramebuffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      return { texture, fbo, width, height, texel: [1 / width, 1 / height] }
    }

    const createPair = (
      width: number,
      height: number,
      internalFormat: number,
      format: number,
      filter: number
    ): Pair => {
      let read = createTarget(width, height, internalFormat, format, filter)
      let write = createTarget(width, height, internalFormat, format, filter)
      return {
        get read() {
          return read
        },
        get write() {
          return write
        },
        swap() {
          const next = read
          read = write
          write = next
        },
        targets() {
          return [read, write]
        }
      }
    }

    const destroyTarget = (target: Target) => {
      gl.deleteTexture(target.texture)
      gl.deleteFramebuffer(target.fbo)
    }

    const release = () => {
      const t = state.targets
      if (!t) return
      ;[
        ...t.velocity.targets(),
        ...t.dye.targets(),
        ...t.pressure.targets(),
        t.divergence,
        t.forward,
        t.back,
        ...t.bloom
      ].forEach(destroyTarget)
      state.targets = null
    }

    const clearTargets = () => {
      const t = state.targets
      if (!t) return
      gl.clearColor(0, 0, 0, 0)
      ;[...t.velocity.targets(), ...t.dye.targets(), ...t.pressure.targets()].forEach((target) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
        gl.clear(gl.COLOR_BUFFER_BIT)
      })
    }

    const allocate = () => {
      const s = settingsRef.current
      const key = `${s.quality}|${state.width}|${state.height}|${canvas.width}|${canvas.height}`
      if (key === state.allocated && state.targets) return
      release()
      state.allocated = key
      const preset = QUALITY[s.quality]
      const aspect = state.width / state.height
      const dims = (base: number) =>
        aspect >= 1 ? [Math.round(base * aspect), base] : [base, Math.round(base / aspect)]
      const [simW, simH] = dims(preset.sim)
      let [dyeW, dyeH] = dims(preset.dye)
      const shrink = Math.min(1, canvas.width / dyeW, canvas.height / dyeH)
      dyeW = Math.max(2, Math.round(dyeW * shrink))
      dyeH = Math.max(2, Math.round(dyeH * shrink))
      const bloom: Target[] = []
      let bloomW = dyeW >> 1
      let bloomH = dyeH >> 1
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        bloom.push(
          createTarget(Math.max(1, bloomW), Math.max(1, bloomH), gl.RGBA16F, gl.RGBA, gl.LINEAR)
        )
        bloomW >>= 1
        bloomH >>= 1
      }
      state.targets = {
        velocity: createPair(simW, simH, gl.RG16F, gl.RG, gl.LINEAR),
        dye: createPair(dyeW, dyeH, gl.RGBA16F, gl.RGBA, gl.LINEAR),
        forward: createTarget(dyeW, dyeH, gl.RGBA16F, gl.RGBA, gl.LINEAR),
        back: createTarget(dyeW, dyeH, gl.RGBA16F, gl.RGBA, gl.LINEAR),
        pressure: createPair(simW, simH, gl.R16F, gl.RED, gl.NEAREST),
        divergence: createTarget(simW, simH, gl.R16F, gl.RED, gl.NEAREST),
        bloom
      }
    }

    const resize = () => {
      const s = settingsRef.current
      const width = Math.max(1, container.clientWidth)
      const height = Math.max(1, container.clientHeight)
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.max(0.5, s.maxDevicePixelRatio || 2)
      )
      const pixelWidth = Math.max(1, Math.round(width * ratio))
      const pixelHeight = Math.max(1, Math.round(height * ratio))
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }
      state.width = width
      state.height = height
      state.ratio = ratio
      allocate()
    }

    const draw = (target: Target | null) => {
      if (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
        gl.viewport(0, 0, target.width, target.height)
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, canvas.width, canvas.height)
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const bindPass = (pass: Pass, texel: number[]) => {
      gl.useProgram(pass.program)
      if (pass.uniforms.uTexel) gl.uniform2f(pass.uniforms.uTexel, texel[0], texel[1])
      return pass.uniforms
    }

    const bind = (unit: number, target: Target) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, target.texture)
      return unit
    }

    const splat = (
      pair: Pair,
      ax: number,
      ay: number,
      bx: number,
      by: number,
      radius: number,
      value: number[],
      mode: number,
      strength: number,
      wide = radius
    ) => {
      const u = bindPass(pass.splat, pair.read.texel)
      gl.uniform1i(u.uTarget, bind(0, pair.read))
      gl.uniform1f(u.uAspect, state.width / state.height)
      gl.uniform2f(u.uA, ax / state.width, 1 - ay / state.height)
      gl.uniform2f(u.uB, bx / state.width, 1 - by / state.height)
      gl.uniform1f(u.uRadius, radius / state.height)
      gl.uniform1f(u.uWide, wide / state.height)
      gl.uniform3f(u.uValue, value[0], value[1], value[2])
      gl.uniform1f(u.uMode, mode)
      gl.uniform1f(u.uStrength, strength)
      draw(pair.write)
      pair.swap()
    }

    const toGrid = (vx: number, vy: number) => {
      const { velocity } = state.targets as Targets
      return [(vx * velocity.read.width) / state.width, (-vy * velocity.read.height) / state.height]
    }

    const lightRadius = (s: Settings) =>
      Math.max(
        s.trailWidth * 0.5,
        (state.height / (state.targets as Targets).dye.read.height) * 0.9
      )

    const emit = (s: Settings, dt: number, now: number) => {
      const { emitter, pointer } = state
      const { velocity, dye } = state.targets as Targets
      emitter.px = emitter.x
      emitter.py = emitter.y
      if (reduce || s.followSpeed >= 1) {
        emitter.x = pointer.x
        emitter.y = pointer.y
      } else {
        const omega = 10 + s.followSpeed * 50
        const steps = Math.max(1, Math.ceil(dt / 0.004))
        const h = dt / steps
        for (let k = 0; k < steps; k++) {
          emitter.vx += (omega * omega * (pointer.x - emitter.x) - 2 * omega * emitter.vx) * h
          emitter.vy += (omega * omega * (pointer.y - emitter.y) - 2 * omega * emitter.vy) * h
          emitter.x += emitter.vx * h
          emitter.y += emitter.vy * h
        }
      }
      const dx = emitter.x - emitter.px
      const dy = emitter.y - emitter.py
      const length = Math.hypot(dx, dy)
      if (length < 0.05 || !s.enabled) return
      const radius = lightRadius(s)
      if (!reduce) {
        const target = toGrid(dx / Math.max(dt, 1e-3), dy / Math.max(dt, 1e-3))
        splat(
          velocity,
          emitter.px,
          emitter.py,
          emitter.x,
          emitter.y,
          radius * 4 + 18,
          [target[0], target[1], 0],
          3,
          FLOW * 0.6
        )
      }
      splat(
        dye,
        emitter.px,
        emitter.py,
        emitter.x,
        emitter.y,
        radius,
        [5.6, 5.6, 0.7],
        2,
        1,
        radius * 5 + 6
      )
      state.active = now
    }

    const burst = (s: Settings, x: number, y: number, now: number) => {
      const { velocity, dye } = state.targets as Targets
      const radius = lightRadius(s)
      const jets = 6
      const base = Math.random() * Math.PI * 2
      for (let k = 0; k < jets; k++) {
        const angle = base + (k / jets) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
        const cx = Math.cos(angle)
        const cy = Math.sin(angle)
        const reach = 20 + Math.random() * 14
        const ax = x + cx * 3
        const ay = y + cy * 3
        const bx = x + cx * reach
        const by = y + cy * reach
        if (!reduce) {
          const target = toGrid(Math.cos(angle + 0.6) * 760, Math.sin(angle + 0.6) * 760)
          splat(velocity, ax, ay, bx, by, 18, [target[0], target[1], 0], 1, 0.9)
        }
        splat(dye, ax, ay, bx, by, radius * 1.1, [2.4, 2.4, 0.3], 0, 1, radius * 5 + 6)
      }
      splat(dye, x, y, x + 0.01, y, radius * 2.2, [1.8, 1.8, 0.4], 0, 1, radius * 7 + 10)
      state.active = now
    }

    const step = (s: Settings, dt: number) => {
      const { velocity, dye, pressure, divergence } = state.targets as Targets
      if (!reduce) {
        let u = bindPass(pass.divergence, velocity.read.texel)
        gl.uniform1i(u.uVelocity, bind(0, velocity.read))
        draw(divergence)

        u = bindPass(pass.scale, pressure.read.texel)
        gl.uniform1i(u.uSource, bind(0, pressure.read))
        gl.uniform1f(u.uValue, 0.8)
        draw(pressure.write)
        pressure.swap()

        u = bindPass(pass.pressure, pressure.read.texel)
        gl.uniform1i(u.uDivergence, bind(1, divergence))
        for (let i = 0; i < PRESSURE_STEPS; i++) {
          gl.uniform1i(u.uPressure, bind(0, pressure.read))
          draw(pressure.write)
          pressure.swap()
        }

        u = bindPass(pass.gradient, velocity.read.texel)
        gl.uniform1i(u.uPressure, bind(0, pressure.read))
        gl.uniform1i(u.uVelocity, bind(1, velocity.read))
        draw(velocity.write)
        velocity.swap()

        u = bindPass(pass.advect, velocity.read.texel)
        gl.uniform2f(u.uVelocityTexel, velocity.read.texel[0], velocity.read.texel[1])
        gl.uniform1i(u.uVelocity, bind(0, velocity.read))
        gl.uniform1i(u.uSource, bind(0, velocity.read))
        gl.uniform1f(u.uDt, dt)
        const calm = Math.exp(-dt * 1.2)
        gl.uniform4f(u.uDecay, calm, calm, 1, 1)
        draw(velocity.write)
        velocity.swap()
      }

      const decay = [
        Math.exp((-dt * 4.6) / (s.linger * 0.8)),
        Math.exp((-dt * 4.6) / (s.linger * 0.2)),
        Math.exp((-dt * 4.6) / (s.linger * 1.2)),
        1
      ]
      const { forward, back } = state.targets as Targets
      if (reduce) {
        const u = bindPass(pass.advect, dye.read.texel)
        gl.uniform2f(u.uVelocityTexel, velocity.read.texel[0], velocity.read.texel[1])
        gl.uniform1i(u.uVelocity, bind(0, velocity.read))
        gl.uniform1i(u.uSource, bind(1, dye.read))
        gl.uniform1f(u.uDt, 0)
        gl.uniform4f(u.uDecay, decay[0], decay[1], decay[2], decay[3])
        draw(dye.write)
        dye.swap()
        return
      }
      let u = bindPass(pass.advect, dye.read.texel)
      gl.uniform2f(u.uVelocityTexel, velocity.read.texel[0], velocity.read.texel[1])
      gl.uniform1i(u.uVelocity, bind(0, velocity.read))
      gl.uniform1i(u.uSource, bind(1, dye.read))
      gl.uniform1f(u.uDt, dt)
      gl.uniform4f(u.uDecay, 1, 1, 1, 1)
      draw(forward)
      gl.uniform1i(u.uSource, bind(1, forward))
      gl.uniform1f(u.uDt, -dt)
      draw(back)
      u = bindPass(pass.maccormack, dye.read.texel)
      gl.uniform2f(u.uVelocityTexel, velocity.read.texel[0], velocity.read.texel[1])
      gl.uniform2f(u.uSourceTexel, dye.read.texel[0], dye.read.texel[1])
      gl.uniform1i(u.uVelocity, bind(0, velocity.read))
      gl.uniform1i(u.uSource, bind(1, dye.read))
      gl.uniform1i(u.uForward, bind(2, forward))
      gl.uniform1i(u.uBack, bind(3, back))
      gl.uniform1f(u.uDt, dt)
      gl.uniform4f(u.uDecay, decay[0], decay[1], decay[2], decay[3])
      draw(dye.write)
      dye.swap()
    }

    const setShade = (u: Record<string, WebGLUniformLocation | null>, s: Settings) => {
      gl.uniform3f(u.uColor, state.color[0], state.color[1], state.color[2])
      gl.uniform3f(u.uSecondary, state.secondary[0], state.secondary[1], state.secondary[2])
      gl.uniform1f(u.uIntensity, s.intensity)
      gl.uniform1f(u.uHotspot, s.hotspot)
    }

    const render = (s: Settings) => {
      const { dye, bloom } = state.targets as Targets
      if (s.glow > 0) {
        let u = bindPass(pass.prefilter, bloom[0].texel)
        gl.uniform1i(u.uDye, bind(0, dye.read))
        gl.uniform2f(u.uDyeTexel, dye.read.texel[0], dye.read.texel[1])
        setShade(u, s)
        draw(bloom[0])
        u = bindPass(pass.down, bloom[0].texel)
        for (let i = 1; i < bloom.length; i++) {
          gl.uniform1i(u.uSource, bind(0, bloom[i - 1]))
          gl.uniform2f(u.uSourceTexel, bloom[i - 1].texel[0], bloom[i - 1].texel[1])
          draw(bloom[i])
        }
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE)
        u = bindPass(pass.up, bloom[0].texel)
        for (let i = bloom.length - 1; i > 0; i--) {
          gl.uniform1i(u.uSource, bind(0, bloom[i]))
          gl.uniform2f(u.uSourceTexel, bloom[i].texel[0], bloom[i].texel[1])
          draw(bloom[i - 1])
        }
        gl.disable(gl.BLEND)
      }
      const u = bindPass(pass.display, [1 / canvas.width, 1 / canvas.height])
      gl.uniform1i(u.uDye, bind(0, dye.read))
      gl.uniform1i(u.uBloom, bind(1, bloom[0]))
      setShade(u, s)
      gl.uniform1f(u.uGlow, s.glow > 0 ? (s.glow * 1.4) / BLOOM_LEVELS : 0)
      gl.uniform1f(u.uGrain, s.grain)
      gl.uniform1f(u.uTime, state.time)
      gl.uniform1f(u.uLight, s.theme === 'light' ? 1 : 0)
      draw(null)
    }

    const blank = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }

    const frame = (now: number) => {
      raf = 0
      if (!alive || !visible || document.hidden) return
      const s = settingsRef.current
      const dt = last ? Math.min(1 / 30, (now - last) / 1000) : 1 / 60
      last = now
      state.time += dt
      const wanted = Math.min(
        window.devicePixelRatio || 1,
        Math.max(0.5, s.maxDevicePixelRatio || 2)
      )
      if (Math.abs(wanted - state.ratio) > 0.01) resize()
      allocate()
      resolveColors(s)
      gl.bindVertexArray(vao)
      gl.disable(gl.BLEND)

      if (state.ready) emit(s, dt, now)
      while (state.bursts.length) {
        const [x, y] = state.bursts.shift() as [number, number]
        burst(s, x, y, now)
      }
      step(s, dt)
      render(s)

      const quiet = now - state.active > s.linger * 1200 + 900
      const resting = Math.hypot(state.emitter.vx, state.emitter.vy) < 1
      if (quiet && resting) {
        clearTargets()
        blank()
        last = 0
        return
      }
      raf = requestAnimationFrame(frame)
    }

    const wake = () => {
      if (!raf && alive && visible && !document.hidden) raf = requestAnimationFrame(frame)
    }

    const onPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
      if (!inside) {
        if (state.pointer.inside) {
          state.pointer.inside = false
          state.ready = false
          wake()
        }
        return
      }
      if (!state.ready) {
        state.emitter.x = x
        state.emitter.y = y
        state.emitter.px = x
        state.emitter.py = y
        state.emitter.vx = 0
        state.emitter.vy = 0
        state.ready = true
      }
      state.pointer.x = x
      state.pointer.y = y
      state.pointer.inside = true
      wake()
    }

    const onPointerDown = (event: PointerEvent) => {
      const s = settingsRef.current
      if (!s.clickBurst || !s.enabled) return
      const rect = container.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return
      state.bursts.push([x, y])
      wake()
    }

    const onPointerLeave = () => {
      state.pointer.inside = false
      state.ready = false
      wake()
    }

    const onVisibility = () => {
      last = 0
      wake()
    }

    const resizeObserver = new ResizeObserver(() => {
      resize()
      wake()
    })
    resizeObserver.observe(container)
    const intersection = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting)
      if (visible) {
        last = 0
        wake()
      }
    })
    intersection.observe(container)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    document.documentElement.addEventListener('pointerleave', onPointerLeave)
    document.addEventListener('visibilitychange', onVisibility)
    resize()
    blank()

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      intersection.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      release()
      Object.values(pass).forEach((item) => gl.deleteProgram(item.program))
      gl.deleteShader(vertexShader)
      gl.deleteBuffer(buffer)
      gl.deleteVertexArray(vao)
    }
  }, [])

  const mode = blendMode ?? (theme === 'light' ? 'normal' : 'screen')

  return (
    <div
      ref={containerRef}
      className={`glow-cursor${className ? ` ${className}` : ''}`}
      style={style}
      {...rest}
    >
      <canvas
        ref={canvasRef}
        className="glow-cursor__canvas"
        style={{ mixBlendMode: mode }}
        aria-hidden="true"
      />
      {children && <div className="glow-cursor__content">{children}</div>}
    </div>
  )
}

export default GlowCursor
