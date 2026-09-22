import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ProcessRunner } from './process'

const DEFAULT_TOP = 4
const MAX_TOP = 6
const MAX_WHY = 3
const ROUTER_TIMEOUT_MS = 60_000

export type RouteMode = 'preview' | 'publication'

export interface RouteCandidate {
  template_id: string
  confidence: string
  score: number
  title: string
  why: string[]
  risks: string[]
  use_when: string
  avoid_when: string
  required_roles: string[]
  role_mapping: Record<string, string>
  preview: string
  preview_markdown: string
}

export interface RouteResult {
  input: {
    rows: number
    columns: Array<{ name: string; type: 'number' | 'text' }>
    roles: Record<string, string>
    sidecars?: string[]
    sidecar_alignment?: string
  }
  candidates: RouteCandidate[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

/**
 * The router's answer is a page of profile statistics around a few recommendations. Keeps
 * what choosing a template needs: the table's columns and the recommendations with their
 * reasons, risks and a preview image the reply can embed.
 */
export function compactRouterOutput(raw: unknown, skillRoot: string): RouteResult {
  const root = isRecord(raw) ? raw : {}
  const profile = isRecord(root.input_profile) ? root.input_profile : {}
  const numeric = new Set(strings(profile.numeric_columns))
  const sidecars = isRecord(profile.sidecars) ? Object.keys(profile.sidecars) : []
  const alignment = isRecord(profile.sidecar_alignment)
    ? profile.sidecar_alignment.status
    : undefined

  const candidates = (Array.isArray(root.recommendations) ? root.recommendations : [])
    .filter(isRecord)
    .map((rec): RouteCandidate => {
      const id = String(rec.id ?? '')
      const preview = typeof rec.preview === 'string' ? join(skillRoot, rec.preview) : ''
      return {
        template_id: id,
        confidence: String(rec.confidence ?? 'unknown'),
        score: typeof rec.score === 'number' ? rec.score : 0,
        title: String(rec.title ?? ''),
        why: strings(rec.rationale).slice(0, MAX_WHY),
        risks: strings(rec.risks),
        use_when: String(rec.use_when ?? ''),
        avoid_when: String(rec.avoid_when ?? ''),
        required_roles: strings(rec.required_roles),
        role_mapping: stringMap(rec.role_mapping),
        preview,
        preview_markdown: preview ? `![${id}](${preview})` : ''
      }
    })

  return {
    input: {
      rows: typeof profile.row_count === 'number' ? profile.row_count : 0,
      columns: strings(profile.columns).map((name) => ({
        name,
        type: numeric.has(name) ? 'number' : 'text'
      })),
      roles: stringMap(profile.role_mapping),
      ...(sidecars.length > 0 ? { sidecars } : {}),
      ...(typeof alignment === 'string' && alignment !== 'not_checked'
        ? { sidecar_alignment: alignment }
        : {})
    },
    candidates
  }
}

export interface RouteRequest {
  dataPath: string
  purpose: string
  mode?: RouteMode
  top?: number
  sidecarDir?: string
}

export type RouteOutcome = { ok: true; result: RouteResult } | { ok: false; error: string }

export async function routeTemplates(
  request: RouteRequest,
  skillRoot: string,
  run: ProcessRunner
): Promise<RouteOutcome> {
  if (!existsSync(request.dataPath) || !statSync(request.dataPath).isFile()) {
    return { ok: false, error: `The data table was not found: ${request.dataPath}` }
  }
  const top = Math.min(Math.max(Math.floor(request.top ?? DEFAULT_TOP), 1), MAX_TOP)
  const args = [
    join(skillRoot, 'scripts', 'route_template.py'),
    '--input',
    request.dataPath,
    '--query',
    request.purpose,
    '--mode',
    request.mode ?? 'preview',
    '--top',
    String(top),
    ...(request.sidecarDir ? ['--sidecar-dir', request.sidecarDir] : []),
    '--json'
  ]
  const outcome = await run('python3', args, { timeoutMs: ROUTER_TIMEOUT_MS })
  if (outcome.spawnError) {
    return {
      ok: false,
      error: `python3 was not found (${outcome.spawnError}). The template router needs Python 3 on PATH; report this as a missing dependency.`
    }
  }
  if (outcome.timedOut || outcome.code !== 0) {
    const detail = outcome.timedOut ? 'timed out' : outcome.stderr.trim().slice(-800)
    return { ok: false, error: `The template router failed: ${detail}` }
  }
  try {
    return { ok: true, result: compactRouterOutput(JSON.parse(outcome.stdout), skillRoot) }
  } catch {
    return { ok: false, error: 'The template router returned output that is not JSON.' }
  }
}
