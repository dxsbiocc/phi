import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { release as osRelease } from 'node:os'

import { collectIncludedFiles } from './composition/includes'
import type { NextflowLaunch } from './composition/nextflow-launch'
import { readLocalNextflowVersion } from './composition/nextflow-version'
import type { WrapperContainerImageProvenance, WrapperRuntimeProvenance } from './types'

const CONTAINER_DIRECTIVE = /^\s*container\s+([\s\S]*?)(?:\n|$)/gm
const QUOTED_LITERAL = /(['"])([^'"\n]+)\1/g
const INLINE_DIGEST = /@(sha256:[0-9a-f]{64})/i
const PROBE_TIMEOUT_MS = 3_000

export type CommandProbe = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv
) => Promise<string | undefined>

export interface RuntimeProvenanceDeps {
  probeCommand?: CommandProbe
  readNextflowVersion?: (nextflowBin: string) => Promise<string | undefined>
  host?: { platform: string; arch: string; release: string }
  now?: () => string
}

function defaultProbeCommand(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, env: env ?? process.env },
      (error, stdout, stderr) => {
        if (error) {
          resolve(undefined)
          return
        }
        const text = `${stdout}\n${stderr}`.trim()
        resolve(text || undefined)
      }
    )
  })
}

function looksLikeContainerRef(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes('${')) return false
  if (/^https?:\/\//i.test(trimmed)) return true
  return trimmed.includes('/') || trimmed.includes(':')
}

function extractContainerRefsFromText(text: string, refs: Set<string>): void {
  for (const match of text.matchAll(CONTAINER_DIRECTIVE)) {
    for (const literal of match[1].matchAll(QUOTED_LITERAL)) {
      const candidate = literal[2].trim()
      if (looksLikeContainerRef(candidate)) refs.add(candidate)
    }
  }
}

/**
 * Extracts declared container image references (Docker tags and Singularity URLs)
 * reachable from a wrapper's `main.nf` across `include` statements.
 */
export function collectWrapperContainerRefs(wrapperMainNf: string): string[] {
  if (!existsSync(wrapperMainNf)) return []
  const refs = new Set<string>()
  for (const file of collectIncludedFiles(wrapperMainNf)) {
    try {
      extractContainerRefsFromText(readFileSync(file, 'utf-8'), refs)
    } catch {
      continue
    }
  }
  return [...refs].sort()
}

function normalizeEngine(
  profile: string | undefined
): 'docker' | 'singularity' | 'conda' | 'unknown' {
  if (profile === 'docker') return 'docker'
  if (profile === 'singularity' || profile === 'apptainer') return 'singularity'
  if (profile === 'conda') return 'conda'
  return 'unknown'
}

function parseDockerRepoDigest(output: string | undefined): string | undefined {
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output) as unknown
    if (Array.isArray(parsed)) {
      const first = parsed.find(
        (item): item is string => typeof item === 'string' && item.includes('sha256:')
      )
      if (first) return first
    }
  } catch {
    const fallback = /sha256:[0-9a-f]{64}/i.exec(output)?.[0]
    if (fallback) return fallback
  }
  return undefined
}

async function inspectContainerImages(
  engine: 'docker' | 'singularity' | 'conda' | 'unknown',
  refs: readonly string[],
  probe: CommandProbe,
  env?: NodeJS.ProcessEnv
): Promise<WrapperContainerImageProvenance[]> {
  if (engine === 'conda' || refs.length === 0) return []
  const results: WrapperContainerImageProvenance[] = []
  for (const ref of refs) {
    const inline = INLINE_DIGEST.exec(ref)?.[1]
    if (inline) {
      results.push({ ref, digest: inline, status: 'verified' })
      continue
    }
    if (engine === 'docker' && !/^https?:\/\//i.test(ref)) {
      const raw = await probe(
        'docker',
        ['image', 'inspect', '--format', '{{json .RepoDigests}}', ref],
        env
      )
      const digest = parseDockerRepoDigest(raw)
      results.push(digest ? { ref, digest, status: 'verified' } : { ref, status: 'unknown' })
      continue
    }
    results.push({ ref, status: 'unknown' })
  }
  return results
}

async function probeContainerRuntimeVersion(
  engine: 'docker' | 'singularity' | 'conda' | 'unknown',
  probe: CommandProbe,
  env?: NodeJS.ProcessEnv
): Promise<string | undefined> {
  if (engine === 'docker') {
    return (await probe('docker', ['--version'], env))?.split('\n')[0]?.trim()
  }
  if (engine === 'singularity') {
    const singularity = (await probe('singularity', ['--version'], env))?.split('\n')[0]?.trim()
    if (singularity) return singularity
    return (await probe('apptainer', ['--version'], env))?.split('\n')[0]?.trim()
  }
  return undefined
}

export async function captureLocalRuntimeProvenance(
  input: {
    launch: NextflowLaunch
    profile?: string
    wrapperMainNf?: string
  },
  deps: RuntimeProvenanceDeps = {}
): Promise<WrapperRuntimeProvenance> {
  const probe = deps.probeCommand ?? defaultProbeCommand
  const readVersion = deps.readNextflowVersion ?? readLocalNextflowVersion
  const host = deps.host ?? {
    platform: process.platform,
    arch: process.arch,
    release: osRelease()
  }
  const capturedAt = (deps.now ?? (() => new Date().toISOString()))()
  const version =
    input.launch.source === 'host'
      ? input.launch.version
      : await readVersion(input.launch.command).catch(() => undefined)

  const engine = normalizeEngine(input.profile)
  const refs = input.wrapperMainNf ? collectWrapperContainerRefs(input.wrapperMainNf) : []
  const [engineVersion, images] = await Promise.all([
    probeContainerRuntimeVersion(engine, probe, input.launch.env),
    inspectContainerImages(engine, refs, probe, input.launch.env)
  ])

  return {
    capturedAt,
    host,
    nextflow:
      input.launch.source === 'managed'
        ? {
            source: 'managed',
            ...(version ? { version } : {}),
            ref: input.launch.ref,
            envId: input.launch.envId,
            ...(input.launch.lockSha256 ? { lockSha256: input.launch.lockSha256 } : {}),
            resolvedCommand: input.launch.command
          }
        : {
            source: 'host',
            version: input.launch.version,
            resolvedCommand: input.launch.command
          },
    containerRuntime: {
      engine,
      ...(engineVersion ? { version: engineVersion } : {}),
      images
    }
  }
}
