import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { signRegistryIndex } from '../../src/main/agent/packages/signature'
import { readRegistryAsset } from '../../src/main/agent/packages/registry-assets'
import {
  buildRegistryWithReport,
  type RegistryBuildResult,
  type RegistryIndex
} from './build-registry'

export interface PrepareOfficialReleaseOptions {
  sourceRoot: string
  outDir: string
  privateKeyFile: string
  generatedAt?: string
  wrapperVersion?: string
}

export interface PreparedOfficialRelease extends RegistryBuildResult {
  assetsDir: string
  /** Flat filenames suitable for GitHub release upload. Never contains the key. */
  assetFiles: string[]
}

/** Build against an independent content checkout, then sign the final flat index. */
export function prepareOfficialRelease(
  options: PrepareOfficialReleaseOptions
): PreparedOfficialRelease {
  const sourceRoot = resolve(options.sourceRoot)
  const outDir = resolve(options.outDir)
  const assetsDir = join(outDir, 'assets')
  if (existsSync(assetsDir)) throw new Error(`release output already exists: ${assetsDir}`)
  mkdirSync(outDir, { recursive: true })
  const staging = mkdtempSync(join(outDir, 'prepare-'))
  try {
    const buildDir = join(staging, 'build')
    const flatDir = join(staging, 'assets')
    mkdirSync(flatDir)
    const built = buildRegistryWithReport({
      repoRoot: sourceRoot,
      outDir: buildDir,
      generatedAt: options.generatedAt,
      wrapperVersion: options.wrapperVersion ?? '0.1.1'
    })
    const names = new Set(['index.json', 'index.sig.json'])
    const copy = (asset: { path: string; sha256: string; size: number }): string => {
      const name = basename(asset.path)
      if (names.has(name)) throw new Error(`release asset filename collision: ${name}`)
      names.add(name)
      readRegistryAsset(buildDir, asset)
      copyFileSync(join(buildDir, asset.path), join(flatDir, name))
      return name
    }
    const index: RegistryIndex = {
      ...built.index,
      packages: built.index.packages.map((entry) => ({
        ...entry,
        archive: copy({ path: entry.archive, sha256: entry.sha256, size: entry.size }),
        ...(entry.iconAsset
          ? { iconAsset: { ...entry.iconAsset, path: copy(entry.iconAsset) } }
          : {}),
        ...(entry.manifestAsset
          ? { manifestAsset: { ...entry.manifestAsset, path: copy(entry.manifestAsset) } }
          : {})
      }))
    }
    const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
    writeFileSync(join(flatDir, 'index.json'), indexBytes)
    const signature = signRegistryIndex(indexBytes, readFileSync(resolve(options.privateKeyFile)))
    writeFileSync(join(flatDir, 'index.sig.json'), `${JSON.stringify(signature, null, 2)}\n`)
    renameSync(flatDir, assetsDir)
    return { index, report: built.report, assetsDir, assetFiles: [...names].sort() }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function argument(argv: string[], name: string, required = false): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0 && !required) return undefined
  const value = index < 0 ? undefined : argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2)
    const result = prepareOfficialRelease({
      sourceRoot: argument(argv, '--source', true)!,
      outDir: argument(argv, '--out', true)!,
      privateKeyFile: argument(argv, '--key', true)!,
      wrapperVersion: argument(argv, '--wrapper-version'),
      generatedAt: argument(argv, '--generated-at')
    })
    console.log(
      `Prepared ${result.index.packages.length} packages and ${result.assetFiles.length} flat catalog-v1 assets: ${result.assetsDir}`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
