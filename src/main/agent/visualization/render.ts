import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

import type { ProcessRunner } from './process'
import { resolveInsideProject } from './project-path'
import { scriptInputNames } from './template-source'

const DEFAULT_TIMEOUT_SECONDS = 180
const MAX_TIMEOUT_SECONDS = 900
const QA_TIMEOUT_MS = 60_000
const ERROR_TAIL_CHARS = 1200
const MESSAGE_CHARS = 400
const OUTPUT_EXTENSIONS = new Set(['.png', '.pdf', '.svg'])
const MISSING_PACKAGE = /there is no package called [‘'"]([^’'"]+)[’'"]/g

export interface RenderQa {
  ok: boolean
  /** Names of the QA checks that did not pass. */
  failed: string[]
}

export interface RenderedFigure {
  ok: true
  output: string
  bytes: number
  format?: string
  width?: number
  height?: number
  qa: RenderQa
  /** What R printed while rendering (warnings, mostly), cut short. */
  messages?: string
}

export type RenderOutcome = { ok: true; result: RenderedFigure } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface QaSummary {
  qa: RenderQa
  format?: string
  width?: number
  height?: number
}

function summarizeQa(stdout: string): QaSummary {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const checks =
      isRecord(parsed) && Array.isArray(parsed.checks) ? parsed.checks.filter(isRecord) : []
    const failed = checks.filter((check) => check.ok === false).map((check) => String(check.name))
    const dimensions = checks.find((check) => typeof check.format === 'string')
    return {
      qa: { ok: isRecord(parsed) && parsed.ok === true, failed },
      ...(dimensions
        ? {
            format: String(dimensions.format),
            ...(typeof dimensions.width === 'number' ? { width: dimensions.width } : {}),
            ...(typeof dimensions.height === 'number' ? { height: dimensions.height } : {})
          }
        : {})
    }
  } catch {
    return { qa: { ok: false, failed: ['qa_unavailable'] } }
  }
}

const UTF8 = /utf-?8/i

/**
 * R reads file names and column names in the locale it starts in. Templates ship Chinese glyph
 * file names and headers such as "Flow(m³/s)", so a process started without a UTF-8 locale (an
 * app launched from the Finder, a bare `C` locale) fails on them. Adds one only when there is none.
 */
export function utf8LocaleEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  if (UTF8.test(effective)) return {}
  return { LC_ALL: platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' }
}

function rFailure(stderr: string): string {
  const missing = [...new Set([...stderr.matchAll(MISSING_PACKAGE)].map((match) => match[1]))]
  const tail = stderr.trim().slice(-ERROR_TAIL_CHARS)
  const head = missing.length
    ? `R package(s) not installed: ${missing.join(', ')}. Do not install packages; report the missing dependency.\n`
    : 'R failed.\n'
  return `${head}${tail}`
}

export async function renderFigure(
  request: {
    skillRoot: string
    cwd: string
    script: string
    inputs: readonly string[]
    output: string
    timeoutSeconds?: number
  },
  run: ProcessRunner
): Promise<RenderOutcome> {
  const script = resolveInsideProject(request.cwd, request.script, 'The script')
  if (!script.ok) return { ok: false, error: script.error }
  const output = resolveInsideProject(request.cwd, request.output, 'The output file')
  if (!output.ok) return { ok: false, error: output.error }
  if (!OUTPUT_EXTENSIONS.has(extname(output.path).toLowerCase())) {
    return { ok: false, error: 'The output file must be a .png, .pdf or .svg file.' }
  }
  if (!existsSync(script.path)) {
    return {
      ok: false,
      error: `The script was not found: ${script.path}. Create it with viz_prepare.`
    }
  }
  const missing = request.inputs.filter((input) => !existsSync(input))
  if (request.inputs.length === 0 || missing.length > 0) {
    return {
      ok: false,
      error:
        missing.length > 0
          ? `Input file(s) not found: ${missing.join(', ')}`
          : 'At least one input table is required.'
    }
  }
  const expected = scriptInputNames(readFileSync(script.path, 'utf-8'))
  if (expected && expected.length !== request.inputs.length) {
    return {
      ok: false,
      error: `This template expects ${expected.length} input(s): ${expected.join(', ')}; got ${request.inputs.length}.`
    }
  }

  mkdirSync(dirname(output.path), { recursive: true })
  const seconds = Math.min(
    Math.max(Math.floor(request.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS), 1),
    MAX_TIMEOUT_SECONDS
  )
  const ran = await run('Rscript', [script.path, ...request.inputs, output.path], {
    cwd: dirname(script.path),
    env: { ...utf8LocaleEnv(), OMICS_VISUALIZATION_SKILL_ROOT: request.skillRoot },
    timeoutMs: seconds * 1000
  })
  if (ran.spawnError) {
    return {
      ok: false,
      error: `Rscript was not found (${ran.spawnError}). Rendering needs R on PATH; report this as a missing dependency and do not install it.`
    }
  }
  if (ran.timedOut) return { ok: false, error: `R timed out after ${seconds} s.` }
  if (ran.code !== 0) return { ok: false, error: rFailure(ran.stderr) }
  if (!existsSync(output.path) || statSync(output.path).size === 0) {
    return {
      ok: false,
      error: `R finished but did not write ${output.path}. Check the output path the script uses (${basename(script.path)} takes it as its last argument).`
    }
  }

  const qa = await run(
    'python3',
    [join(request.skillRoot, 'scripts', 'qa_single_plot.py'), output.path, '--json'],
    { timeoutMs: QA_TIMEOUT_MS }
  )
  const summary =
    qa.spawnError || qa.timedOut
      ? { qa: { ok: false, failed: ['qa_unavailable'] } }
      : summarizeQa(qa.stdout)
  const messages = ran.stderr.trim().slice(-MESSAGE_CHARS)
  return {
    ok: true,
    result: {
      ok: true,
      output: output.path,
      bytes: statSync(output.path).size,
      ...summary,
      ...(messages ? { messages } : {})
    }
  }
}
