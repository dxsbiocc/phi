/* eslint-disable @typescript-eslint/explicit-function-return-type */
// App-local MSVC runtime sidecars for the bundled Windows micromamba.
//
// micromamba-win-64 imports MSVCP140.dll, VCRUNTIME140.dll and VCRUNTIME140_1.dll.
// None are OS components, so a clean Windows host fails at load with 0xC0000135
// (STATUS_DLL_NOT_FOUND) before main() runs. Ship those three next to
// micromamba.exe, taken verbatim from the conda-forge vc14_runtime package that
// the Python/Jupyter locks already pin, and carry that package's licence files.
//
// Redistribution is NOT established by this module: the vc14_runtime licence
// restricts distribution, and Microsoft conditions redistribution on being a
// licensed Visual Studio user. Carrying notices does not establish redistribution rights.
//
// Read the outer ZIP with bsdtar (or unzip on Linux), decompress with Node,
// and read selected tar members. No system zstd executable is required.
// Only the pinned members are read; archive paths are never extracted to disk.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const WINDOWS_RUNTIME_NAMES = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
export const WINDOWS_LICENSE_NAMES = ['LICENSE.TXT', 'LICENSE.RTF', 'LICENSE.DOCX']

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_MEMBER = /^(?:Library\/bin|info\/licenses)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TAR_MAX_BUFFER = 32 * 1024 * 1024

export function lookupVcRuntime(manifest, platformId = 'win32-x64') {
  const entry = manifest?.micromamba?.platforms?.[platformId]
  const runtime = entry?.vcRuntime
  if (!runtime || typeof runtime !== 'object') return undefined
  const archive = runtime.archive
  if (!archive || typeof archive.url !== 'string' || typeof archive.sha256 !== 'string')
    return undefined
  if (!Array.isArray(runtime.files) || !Array.isArray(runtime.licenses)) return undefined
  const wanted = [...WINDOWS_RUNTIME_NAMES, ...WINDOWS_LICENSE_NAMES].sort()
  const listed = [...runtime.files, ...runtime.licenses]
    .map((file) => (typeof file?.name === 'string' ? file.name : ''))
    .sort()
  if (listed.length !== wanted.length || listed.some((name, index) => name !== wanted[index])) {
    return undefined
  }
  return runtime
}

export function runtimeTargetDir(repoRoot, platformId = 'win32-x64') {
  return path.join(repoRoot, 'resources', 'runtime', 'micromamba', platformId)
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sidecarProblems(directory, runtime) {
  const problems = []
  for (const file of [...runtime.files, ...runtime.licenses]) {
    const target = path.join(directory, file.name)
    if (!existsSync(target) || !statSync(target).isFile()) {
      problems.push(`missing ${file.name}`)
      continue
    }
    if (sha256File(target) !== file.sha256) problems.push(`checksum mismatch for ${file.name}`)
  }
  return problems
}

/** Default tar runner: one member, bounded output. Tests inject a substitute. */
export function runTar(args, execute = execFileSync) {
  const options = {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: TAR_MAX_BUFFER
  }
  try {
    return execute('tar', args, options)
  } catch (error) {
    // GNU tar cannot read the outer ZIP; Windows/macOS bsdtar can.
    if (!args[1]?.endsWith('.conda')) throw error
    return execute(
      'unzip',
      args[0] === '-tf' ? ['-Z1', args[1]] : ['-p', args[1], args[2]],
      options
    )
  }
}

function listArchive(archivePath, tar) {
  const names = tar(['-tf', archivePath])
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (names.length === 0) {
    throw new Error(`windows-micromamba-runtime: ${archivePath} listed no members`)
  }
  return names
}

/**
 * Extract the pinned members out of the .conda archive using system tar.
 * First hop materialises the inner zstd tar in a scratch directory the caller
 * owns; second hop reads only the allowlisted members from it.
 */
export function extractSidecars(archivePath, runtime, options = {}) {
  const tar = options.tar ?? runTar
  const scratch = options.scratch
  if (!scratch)
    throw new Error('windows-micromamba-runtime: extractSidecars needs a scratch directory')
  for (const file of [...runtime.files, ...runtime.licenses]) {
    if (!SAFE_MEMBER.test(file.member)) {
      throw new Error(`windows-micromamba-runtime: unsafe member name ${file.member}`)
    }
  }
  const listing = listArchive(archivePath, tar)
  const payload = listing.find((name) => name.startsWith('pkg-') && name.endsWith('.tar.zst'))
  const info = listing.find((name) => name.startsWith('info-') && name.endsWith('.tar.zst'))
  if (!payload) throw new Error('windows-micromamba-runtime: package payload not found in .conda')
  if (!info) throw new Error('windows-micromamba-runtime: info payload not found in .conda')

  const out = new Map()
  for (const [archive, members] of [
    [payload, runtime.files],
    [info, runtime.licenses]
  ]) {
    const inner = path.join(scratch, path.basename(archive, '.zst'))
    writeFileSync(
      inner,
      zstdDecompressSync(tar(['-xOf', archivePath, archive]), { maxOutputLength: TAR_MAX_BUFFER })
    )
    for (const file of members) out.set(file.member, tar(['-xOf', inner, file.member]))
  }
  for (const file of [...runtime.files, ...runtime.licenses]) {
    if (!out.has(file.member)) {
      throw new Error(`windows-micromamba-runtime: archive is missing ${file.member}`)
    }
  }
  return out
}

function assertSafeTarget(directory, name) {
  if (!SAFE_NAME.test(name)) throw new Error(`windows-micromamba-runtime: unsafe file name ${name}`)
  const target = path.join(directory, name)
  if (path.dirname(target) !== path.resolve(directory)) {
    throw new Error(`windows-micromamba-runtime: ${name} escapes ${directory}`)
  }
  return target
}

/**
 * Write the sidecars. Every buffer is hashed against the manifest BEFORE any
 * destination is touched, so a corrupt member late in the set cannot leave a
 * half-updated runtime directory.
 */
export function installSidecars(directory, extracted, runtime) {
  const planned = []
  for (const file of [...runtime.files, ...runtime.licenses]) {
    const buffer = extracted.get(file.member)
    if (!Buffer.isBuffer(buffer)) {
      throw new Error(`windows-micromamba-runtime: no bytes for ${file.member}`)
    }
    if (sha256Buffer(buffer) !== file.sha256) {
      throw new Error(`windows-micromamba-runtime: checksum mismatch for ${file.member}`)
    }
    planned.push({ file, buffer, target: assertSafeTarget(directory, file.name) })
  }
  mkdirSync(directory, { recursive: true })
  const written = []
  for (const { file, buffer, target } of planned) {
    const partial = `${target}.${process.pid}.partial`
    try {
      writeFileSync(partial, buffer)
      if (file.name.toLowerCase().endsWith('.dll')) chmodSync(partial, 0o755)
      renameSync(partial, target)
    } finally {
      rmSync(partial, { force: true })
    }
    written.push(file.name)
  }
  return written
}

/**
 * Ensure the Windows sidecars match the manifest. A cached micromamba.exe alone
 * never satisfies this: every DLL and licence is verified, and missing or
 * corrupt files are re-extracted from the pinned archive.
 *
 * All scratch state (download, inner tars) lives under one mkdtemp directory
 * inside the owned target and is removed in `finally`; nothing is cached in the
 * shipped runtime directory.
 */
export function ensureWindowsRuntimeSidecars(options) {
  const {
    repoRoot,
    manifest,
    download,
    platformId = 'win32-x64',
    extract = extractSidecars,
    tar = runTar
  } = options
  const runtime = lookupVcRuntime(manifest, platformId)
  if (!runtime) {
    throw new Error(`windows-micromamba-runtime: manifest has no vcRuntime entry for ${platformId}`)
  }
  const directory = runtimeTargetDir(repoRoot, platformId)
  const before = sidecarProblems(directory, runtime)
  if (before.length === 0) return { status: 'ready', repaired: false, written: [] }
  mkdirSync(directory, { recursive: true })

  const scratch = mkdtempSync(path.join(directory, '.vc14-'))
  try {
    const archivePath = path.join(scratch, 'vc14_runtime.conda')
    if (typeof download === 'function') {
      download(archivePath)
    } else if (!existsSync(archivePath)) {
      throw new Error(
        `windows-micromamba-runtime: sidecars incomplete (${before.join(', ')}) and no downloader available`
      )
    }
    const digest = sha256File(archivePath)
    if (digest !== runtime.archive.sha256) {
      throw new Error(
        `windows-micromamba-runtime: archive checksum mismatch: expected ${runtime.archive.sha256}, got ${digest}`
      )
    }
    const extracted = extract(archivePath, runtime, { scratch, tar })
    const written = installSidecars(directory, extracted, runtime)
    const after = sidecarProblems(directory, runtime)
    if (after.length > 0) {
      throw new Error(`windows-micromamba-runtime: sidecars still invalid: ${after.join(', ')}`)
    }
    return { status: 'repaired', repaired: true, written }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
