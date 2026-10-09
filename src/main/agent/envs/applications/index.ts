import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import { currentPlatform, type PhiPlatform } from '../platform'
import type { EnvironmentSpec } from '../contract'
import type { EnsureEnvironmentInput } from '../ensure'
import {
  cacheVerifiedArtifact,
  installationSpecSha256,
  readVerifiedInstallationAsset,
  safeApplicationRelativePath
} from './artifacts'
import { installNativeApplication } from './native'
import { installBunApplication } from './bun'
import { installPythonApplication } from './python'
import { installDeclaredApplicationTools, validateDeclaredApplicationTools } from './tools'
import type {
  ApplicationInstallInput,
  ApplicationInstallation,
  ApplicationInstallationMetadata,
  ApplicationInstallResult
} from './types'

interface SourceAsset {
  bytes: Buffer
  sha256: string
}

function sourceAssets(
  installation: ApplicationInstallation,
  sourceDir: string | undefined,
  platform: PhiPlatform
): SourceAsset[] {
  if (!sourceDir || !isAbsolute(sourceDir))
    throw new Error('application installation requires a private source directory')
  const stat = lstatSync(sourceDir)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('application source must be a regular directory without symlinks')
  const read = (path: string, sha256: string): SourceAsset => ({
    bytes: readVerifiedInstallationAsset(sourceDir, path, sha256),
    sha256
  })
  switch (installation.backend) {
    case 'python-uv':
      return [read(installation.requirements, installation.requirementsSha256)]
    case 'javascript-bun': {
      const assets = [
        read(installation.manifest, installation.manifestSha256),
        read(installation.lock, installation.lockSha256)
      ]
      for (const tool of [installation.bun, installation.node]) {
        if (tool && !tool.artifacts[platform])
          throw new Error(`declared application runtime has no artifact for platform ${platform}`)
      }
      return assets
    }
    case 'native':
      if (!installation.artifacts[platform])
        throw new Error(`native application has no artifact for platform ${platform}`)
      return []
  }
}

/** Recheck signed source bytes before reading a ready prefix, including descriptor reuse. */
export function validateApplicationInstallationSource(
  installation: ApplicationInstallation,
  sourceDir: string | undefined,
  platform: PhiPlatform
): void {
  sourceAssets(installation, sourceDir, platform)
}

/** Provider receipts describe the declared executable, which must stay inside its prefix. */
export function validateApplicationMetadata(
  prefix: string,
  installation: ApplicationInstallation,
  metadata: ApplicationInstallationMetadata
): ApplicationInstallationMetadata {
  if (
    metadata.backend !== installation.backend ||
    metadata.specSha256 !== installationSpecSha256(installation)
  )
    throw new Error('application metadata does not match its installation spec')
  const expected = resolve(prefix, 'bin', installation.executable)
  const executable = isAbsolute(metadata.executable)
    ? resolve(metadata.executable)
    : resolve(prefix, 'bin', metadata.executable)
  if (realpathSync(executable) !== realpathSync(expected))
    throw new Error('application metadata executable does not match its prefix entry')
  const within = relative(realpathSync(prefix), realpathSync(executable))
  if (!within || within === '..' || within.startsWith('../') || isAbsolute(within))
    throw new Error('application executable resolves outside its prefix')
  if (!statSync(executable).isFile())
    throw new Error('application executable is not a regular file')
  accessSync(executable, constants.X_OK)
  return { ...metadata, executable: expected }
}

function cacheRoot(root: string, prefix: string, create = true): string {
  const owner = basename(prefix)
  if (!owner || owner === '.' || owner === '..')
    throw new Error('application cache requires an environment prefix')
  const base = realpathSync(root)
  let path = base
  for (const name of ['cache', owner, 'applications']) {
    path = join(path, name)
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('application cache must not escape through symlinks')
  }
  return path
}

function artifactReference(
  artifact: ApplicationInstallationMetadata['artifacts'][number]
): ApplicationInstallationMetadata['artifacts'][number] {
  const path = safeApplicationRelativePath(artifact.key)
  return { ...artifact, key: path.includes('/') ? path : `artifacts/${path}` }
}

/**
 * All provider caches live below cache/<envId>/applications and purge with that environment.
 * Receipt artifact keys are relative to this provider cache root, rather than the runtime.
 */
export async function installApplication(
  input: ApplicationInstallInput
): Promise<ApplicationInstallResult> {
  input.signal?.throwIfAborted()
  const assets = sourceAssets(input.installation, input.sourceDir, input.platform)
  const ownedRoot = cacheRoot(input.root, input.prefix)
  const preserved: ApplicationInstallationMetadata['artifacts'] = []
  for (const asset of assets) {
    const cached = await cacheVerifiedArtifact(ownedRoot, asset.bytes)
    preserved.push({ key: cached.key, sha256: asset.sha256, size: cached.size })
  }
  input.signal?.throwIfAborted()
  const request = { ...input, root: ownedRoot }
  const tools = await installDeclaredApplicationTools(request)
  const provider = {
    native: installNativeApplication,
    'python-uv': installPythonApplication,
    'javascript-bun': installBunApplication
  }[input.installation.backend]
  const installed = validateApplicationMetadata(
    input.prefix,
    input.installation,
    await provider(request)
  )
  const artifacts = [...installed.artifacts, ...preserved, ...tools].map(artifactReference)
  return {
    ...installed,
    artifacts: [...new Map(artifacts.map((artifact) => [artifact.key, artifact])).values()]
  }
}

export function usesNativeApplicationRuntime(
  spec: Pick<EnvironmentSpec, 'installation' | 'dependencies'>
): boolean {
  if (spec.dependencies.length !== 0) return false
  const installation = spec.installation
  return (
    installation?.backend === 'native' ||
    (installation?.backend === 'javascript-bun' &&
      Boolean(installation.bun) &&
      (installation.runtime !== 'node' || Boolean(installation.node)))
  )
}

/** Cached-prefix validation reads pinned runtime bytes only; it cannot download or write. */
export function validateApplicationRuntimeTools(input: ApplicationInstallInput): void {
  if (
    input.installation.backend !== 'javascript-bun' ||
    (!input.installation.bun && !input.installation.node)
  )
    return
  validateDeclaredApplicationTools({ ...input, root: cacheRoot(input.root, input.prefix, false) })
}

export function validateEnvironmentApplicationTools(
  input: EnsureEnvironmentInput,
  prefix: string
): void {
  if (!input.spec.installation) return
  validateApplicationRuntimeTools({
    root: input.root,
    prefix,
    sourceDir: input.sourceDir!,
    platform: input.platform ?? currentPlatform(),
    installation: input.spec.installation
  })
}

/** Adapt provider progress to the existing environment build and verify injected installers too. */
export async function installEnvironmentApplication(
  input: EnsureEnvironmentInput,
  context: { root: string; prefix: string; platform: PhiPlatform }
): Promise<ApplicationInstallationMetadata | undefined> {
  if (!input.spec.installation) return undefined
  const metadata = await (input.applicationInstaller ?? installApplication)({
    ...context,
    sourceDir: input.sourceDir!,
    installation: input.spec.installation,
    signal: input.signal,
    fetch: input.fetch,
    onProgress: ({ message }) => input.onProgress?.({ phase: 'application', message })
  })
  input.signal?.throwIfAborted()
  return validateApplicationMetadata(context.prefix, input.spec.installation, metadata)
}
