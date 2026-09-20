#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Regenerates `wrapper/dag.mmd` next to every `wrapper/wrapper.yaml` under
// `resources/wrappers/{modules,subworkflows,workflows}/`, using Nextflow's
// own `-preview -with-dag` (skips executing any process — just traces
// channel/process topology from the script + the wrapper's own
// params.json, so this runs in seconds with no Docker/network data
// needed). The composition catalog (`src/main/agent/wrappers/composition/
// discovery.ts`) reads this file, when present, so the Wrappers UI can
// show Nextflow's real DAG instead of the generic 3-node fallback graph
// (`wrapperFlow.ts`'s `buildFallbackGraph`) — see that discussion for why
// a hand-maintained step list or a from-scratch DSL parser were rejected
// in favor of just asking Nextflow, which already builds this exact graph
// for its own `-with-dag` reports.
//
// Committed as a static asset (not generated at app build time or
// on-demand at runtime) — re-run this manually after changing a wrapper's
// `main.nf`/`params.json` and commit the refreshed `dag.mmd`. Requires
// `nextflow` on PATH.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const wrappersRoot = join(repoRoot, 'resources', 'wrappers')
const COMPONENT_ROOTS = ['modules', 'subworkflows', 'workflows']
const MAX_SCAN_DEPTH = 6

function findWrapperDirs(rootDir) {
  const results = []
  function walk(dir, depth) {
    if (depth > MAX_SCAN_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.name === 'wrapper.yaml' && basename(dir) === 'wrapper') {
        results.push(dir)
      }
    }
  }
  walk(rootDir, 0)
  return results
}

function cleanRunArtifacts(componentDir) {
  for (const name of readdirSync(componentDir)) {
    if (name === 'work' || name === 'results' || name.startsWith('.nextflow')) {
      rmSync(join(componentDir, name), { recursive: true, force: true })
    }
  }
}

function generateDag(wrapperDir) {
  const paramsFile = join(wrapperDir, 'params.json')
  if (!existsSync(paramsFile)) {
    console.warn(`  skip (no params.json): ${wrapperDir}`)
    return false
  }
  // Run from the component's own root (wrapper/'s parent), not from inside
  // wrapper/ itself: a full pipeline's own nextflow_schema.json lives at
  // that root, and nf-schema's plugin resolves it relative to launchDir
  // (== cwd here), not projectDir — running from inside wrapper/ breaks
  // that lookup for anything with its own nextflow_schema.json (the
  // workflows tier), even though it's harmless for a single-process module
  // that has none.
  const componentDir = dirname(wrapperDir)
  try {
    execFileSync(
      'nextflow',
      [
        'run',
        'wrapper/main.nf',
        '-params-file',
        'wrapper/params.json',
        '-preview',
        '-with-dag',
        'wrapper/dag.mmd'
      ],
      { cwd: componentDir, stdio: 'pipe' }
    )
    return existsSync(join(wrapperDir, 'dag.mmd'))
  } catch (error) {
    console.error(`  FAILED: ${wrapperDir}`)
    console.error(error.stderr?.toString() ?? error.message)
    return false
  } finally {
    cleanRunArtifacts(componentDir)
  }
}

const wrapperDirs = COMPONENT_ROOTS.flatMap((componentRoot) => {
  const root = join(wrappersRoot, componentRoot)
  return existsSync(root) && statSync(root).isDirectory() ? findWrapperDirs(root) : []
})

console.log(`Found ${wrapperDirs.length} wrapper(s).`)

let okCount = 0
for (const wrapperDir of wrapperDirs) {
  const label = wrapperDir.replace(`${repoRoot}/`, '')
  process.stdout.write(`- ${label} ... `)
  const ok = generateDag(wrapperDir)
  console.log(ok ? 'ok' : 'skipped')
  if (ok) okCount++
}

console.log(`Generated ${okCount}/${wrapperDirs.length} dag.mmd file(s).`)
if (okCount < wrapperDirs.length) process.exitCode = 1
