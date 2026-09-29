import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import semver from 'semver'

import { getPhiAgentDir } from '../../runtime-paths'
import { getBundledWrapperPackagesDir } from '../catalog'
import { getWrapperPacksDir } from '../store'
import type { ActiveWrapperPack, RejectedWrapperPack } from '../../../../shared/wrapperPackTypes'
import { readWrapperPackIndex, readWrapperPackMeta, verifyWrapperPack } from './pack-index'

export type {
  ActiveWrapperPack,
  RejectedWrapperPack,
  WrapperPackSource
} from '../../../../shared/wrapperPackTypes'

/**
 * Picks the one wrapper pack the composition layer runs from.
 *
 * - `bundled`: the tree shipped inside the app. Its integrity is covered by
 *   the app bundle itself, so it is not re-hashed on startup.
 * - `overlay`: a newer pack placed under `~/.phi/wrappers/packs/<version>/`
 *   so a wrapper fix can ship without rebuilding the app. It is used only
 *   when it is the same pack (`name`), strictly newer than the bundled one,
 *   sits in a directory named after its own version, and passes a full
 *   digest check against its `index.json`.
 *
 * Packs replace each other whole; they are never merged file-by-file,
 * because wrappers include each other across the tree by relative path.
 * An app update that ships a bundled pack at least as new as an overlay
 * makes that overlay inert without deleting it.
 */

export interface WrapperPackResolution {
  active: ActiveWrapperPack
  /** Overlay packs that were looked at and not used, with the reason — for diagnostics/UI. */
  rejected: RejectedWrapperPack[]
}

export interface ResolveWrapperPackOptions {
  agentDir?: string
  bundledRoot?: string
}

interface OverlayCandidate {
  root: string
  version: string
}

function listOverlayDirs(packsDir: string): string[] {
  if (!existsSync(packsDir)) return []
  return readdirSync(packsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(packsDir, entry.name))
}

function screenOverlay(
  root: string,
  dirName: string,
  bundled: { name: string; version: string }
): OverlayCandidate | RejectedWrapperPack {
  let meta: ReturnType<typeof readWrapperPackMeta>
  try {
    meta = readWrapperPackMeta(root)
  } catch (error) {
    return { root, reason: error instanceof Error ? error.message : String(error) }
  }
  if (meta.name !== bundled.name) {
    return { root, reason: `包名 ${meta.name} 与内置包 ${bundled.name} 不一致` }
  }
  if (dirName !== meta.version) {
    return { root, reason: `目录名 ${dirName} 与包版本 ${meta.version} 不一致` }
  }
  if (!semver.gt(meta.version, bundled.version)) {
    return { root, reason: `版本 ${meta.version} 不高于内置版本 ${bundled.version}，已忽略` }
  }
  return { root, version: meta.version }
}

function isCandidate(value: OverlayCandidate | RejectedWrapperPack): value is OverlayCandidate {
  return 'version' in value
}

export function resolveActiveWrapperPack(
  options: ResolveWrapperPackOptions = {}
): WrapperPackResolution {
  const bundledRoot = options.bundledRoot ?? getBundledWrapperPackagesDir()
  const bundledMeta = readWrapperPackMeta(bundledRoot)
  const bundled: ActiveWrapperPack = {
    root: bundledRoot,
    name: bundledMeta.name,
    version: bundledMeta.version,
    source: 'bundled',
    // Present in packaged builds (`npm run build` writes it); absent in a dev checkout.
    digest: readWrapperPackIndex(bundledRoot)?.digest
  }

  const packsDir = getWrapperPacksDir(options.agentDir ?? getPhiAgentDir())
  const rejected: RejectedWrapperPack[] = []
  const candidates: OverlayCandidate[] = []
  for (const root of listOverlayDirs(packsDir)) {
    const screened = screenOverlay(root, basename(root), bundledMeta)
    if (isCandidate(screened)) candidates.push(screened)
    else rejected.push(screened)
  }

  // Newest first; verify lazily so a good newest pack costs one hash pass.
  candidates.sort((a, b) => semver.rcompare(a.version, b.version))
  for (const candidate of candidates) {
    const verification = verifyWrapperPack(candidate.root)
    if (verification.ok) {
      return {
        active: {
          root: candidate.root,
          name: verification.index.name,
          version: verification.index.version,
          source: 'overlay',
          digest: verification.index.digest
        },
        rejected
      }
    }
    rejected.push({ root: candidate.root, reason: `完整性校验失败：${verification.reason}` })
  }

  return { active: bundled, rejected }
}
