import { existsSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import { globSync } from 'glob'

import type { ProjectLocation } from '../../../shared/projectLocation'
import type { WrapperCompositionManifest } from '../../../shared/wrapperCompositionManifestTypes'
import type {
  WrapperInputPathMapping,
  WrapperInputReference,
  WrapperInputResolution
} from './types'

const GLOB_CHAR_PATTERN = /[*?[\]{}]/
const REMOTE_URL_PATTERN = /^(https?|s3|gs):\/\//i

export function isGlobPattern(value: string): boolean {
  return GLOB_CHAR_PATTERN.test(value)
}

/** Adapted from DSH ssh/src/schemas.ts@00102833: remote path spelling is POSIX and NUL-free. */
export function isRemoteAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0')
}

/** Adapted from DSH fs-ssh/src/index.ts@00102833: lexical sibling-prefix check; server-side canonicalization follows in C02. */
export function isWithinRemoteRoot(root: string, target: string): boolean {
  const path = posix.relative(root, target)
  return path === '' || (!path.startsWith('../') && path !== '..' && !posix.isAbsolute(path))
}

function isWithinLocalRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

export function validateInputPathMapping(mapping: WrapperInputPathMapping): string[] {
  const errors: string[] = []
  if (!isAbsolute(mapping.localRoot) || mapping.localRoot.includes('\0')) {
    errors.push('The local mapping root must be an absolute path without NUL')
  }
  if (!isRemoteAbsolutePath(mapping.remoteRoot)) {
    errors.push('The server mapping root must be an absolute POSIX path without NUL')
  }
  return errors
}

export function parseWrapperInputReference(
  inputId: string,
  value: unknown,
  defaultSource: WrapperInputReference['source']
): { reference?: WrapperInputReference; errors: string[] } {
  let reference: WrapperInputReference | undefined
  if (typeof value === 'string' && defaultSource !== 'upload') {
    reference = { source: defaultSource, path: value }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort().join(',')
    if (keys === 'source' && record.source === 'upload') {
      reference = { source: 'upload' }
    } else if (
      keys === 'path,source' &&
      (record.source === 'local' || record.source === 'remote') &&
      typeof record.path === 'string'
    ) {
      reference = { source: record.source, path: record.path }
    }
  }
  if (!reference)
    return { errors: [`Input "${inputId}" must be a path or a {source, path} reference`] }
  if (reference.source !== 'upload' && (!reference.path.trim() || reference.path.includes('\0'))) {
    return { errors: [`Input "${inputId}" cannot be empty or contain NUL`] }
  }
  return { reference, errors: [] }
}

export function resolveRemoteInputPath(
  inputId: string,
  value: unknown,
  context: { projectLocation?: ProjectLocation; mapping?: WrapperInputPathMapping }
): PathResolutionResult {
  const parsed = parseWrapperInputReference(inputId, value, 'remote')
  if (!parsed.reference) return { errors: parsed.errors }
  if (parsed.reference.source === 'upload') {
    if (context.projectLocation?.kind !== 'ssh') {
      return { errors: [`Input "${inputId}" can upload local files only in SSH projects`] }
    }
    return {
      resolution: {
        id: inputId,
        kind: 'path',
        source: 'upload',
        userValue: '',
        localPaths: [],
        remotePaths: [],
        allowedRemoteRoot: context.projectLocation.canonicalRoot
      },
      errors: [`Input "${inputId}" is waiting for the user to select local files for upload`]
    }
  }
  const { source, path } = parsed.reference
  if (REMOTE_URL_PATTERN.test(path)) {
    return source === 'remote'
      ? {
          resolution: {
            id: inputId,
            kind: 'path',
            source,
            userValue: path,
            localPaths: [],
            remotePaths: [path]
          },
          errors: []
        }
      : { errors: [`Local input "${inputId}" cannot be a remote URL`] }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return { errors: [`The URL type for input "${inputId}" is not supported`] }
  }

  if (context.projectLocation?.kind === 'ssh') {
    if (source === 'local')
      return { errors: [`Input "${inputId}" in a remote project cannot reference local files`] }
    const root = context.projectLocation.canonicalRoot
    const remotePath = isRemoteAbsolutePath(path)
      ? posix.normalize(path)
      : posix.resolve(root, path)
    if (!isWithinRemoteRoot(root, remotePath)) {
      return { errors: [`Input "${inputId}" is outside the remote project directory: ${path}`] }
    }
    return {
      resolution: {
        id: inputId,
        kind: isGlobPattern(path) ? 'glob' : 'path',
        source,
        userValue: path,
        localPaths: [],
        remotePaths: [remotePath],
        allowedRemoteRoot: root
      },
      errors: []
    }
  }

  if (source === 'local') {
    if (context.projectLocation?.kind !== 'local' || !context.mapping) {
      return {
        errors: [
          `Input "${inputId}" references a local path without a local-to-server path mapping`
        ]
      }
    }
    const mappingErrors = validateInputPathMapping(context.mapping)
    if (mappingErrors.length > 0) return { errors: mappingErrors }
    const localPath = isAbsolute(path) ? resolve(path) : resolve(context.projectLocation.path, path)
    const localRoot = resolve(context.mapping.localRoot)
    if (!isWithinLocalRoot(localRoot, localPath)) {
      return { errors: [`Input "${inputId}" is outside the local mapping root: ${path}`] }
    }
    const suffix = relative(localRoot, localPath).split(sep).join('/')
    const remotePath = posix.resolve(context.mapping.remoteRoot, suffix)
    if (!isWithinRemoteRoot(context.mapping.remoteRoot, remotePath)) {
      return { errors: [`Input "${inputId}" is outside the server mapping root: ${path}`] }
    }
    return {
      resolution: {
        id: inputId,
        kind: isGlobPattern(path) ? 'glob' : 'path',
        source,
        userValue: path,
        localPaths: [localPath],
        remotePaths: [remotePath],
        allowedRemoteRoot: context.mapping.remoteRoot
      },
      errors: []
    }
  }

  const remoteRoot = context.mapping?.remoteRoot
  if (context.projectLocation?.kind === 'local' && !isRemoteAbsolutePath(path) && !remoteRoot) {
    return {
      errors: [`Input "${inputId}" requires an absolute server path or a server mapping root`]
    }
  }
  const remotePath = isRemoteAbsolutePath(path)
    ? posix.normalize(path)
    : remoteRoot
      ? posix.resolve(remoteRoot, path)
      : path
  if (remoteRoot && !isRemoteAbsolutePath(path) && !isWithinRemoteRoot(remoteRoot, remotePath)) {
    return { errors: [`Input "${inputId}" is outside the server mapping root: ${path}`] }
  }
  return {
    resolution: {
      id: inputId,
      kind: isGlobPattern(path) ? 'glob' : 'path',
      source,
      userValue: path,
      localPaths: [],
      remotePaths: [remotePath]
    },
    errors: []
  }
}

/** Resolve only declared composition inputs; options and output params keep their original types. */
export function resolveCompositionInputParams(
  manifest: WrapperCompositionManifest,
  params: Record<string, unknown>,
  context: {
    remote: boolean
    projectLocation?: ProjectLocation
    mapping?: WrapperInputPathMapping
  }
): { params: Record<string, unknown>; inputs: WrapperInputResolution[]; errors: string[] } {
  const resolvedParams = { ...params }
  const inputs: WrapperInputResolution[] = []
  const errors: string[] = []
  for (const [id, declaration] of Object.entries(manifest.params)) {
    if (declaration.kind !== 'input' || params[id] === undefined) continue
    if (context.remote) {
      const result = resolveRemoteInputPath(id, params[id], context)
      errors.push(...result.errors)
      if (result.resolution) {
        inputs.push(result.resolution)
        resolvedParams[id] = result.resolution.remotePaths?.[0]
      }
      continue
    }
    const parsed = parseWrapperInputReference(id, params[id], 'local')
    errors.push(...parsed.errors)
    if (!parsed.reference) continue
    if (parsed.reference.source !== 'local') {
      errors.push(`Local input "${id}" cannot reference server files`)
      continue
    }
    const path = parsed.reference.path
    const localPath =
      typeof params[id] !== 'string' &&
      context.projectLocation?.kind === 'local' &&
      !isAbsolute(path)
        ? resolve(context.projectLocation.path, path)
        : path
    resolvedParams[id] = localPath
    inputs.push({
      id,
      kind: isGlobPattern(path) ? 'glob' : 'path',
      source: 'local',
      userValue: path,
      localPaths: [localPath]
    })
  }
  return { params: resolvedParams, inputs, errors }
}

export interface PathResolutionResult {
  resolution?: WrapperInputResolution
  errors: string[]
}

/**
 * Resolves one manifest input's user-provided value against the local
 * filesystem only. Never throws: every failure
 * mode becomes a validation error string instead, so plan creation can
 * collect every problem in one pass.
 */
export function resolveLocalInputPath(
  inputId: string,
  userValue: string,
  cwd: string
): PathResolutionResult {
  if (!userValue || userValue.trim().length === 0) {
    return { errors: [`Input "${inputId}" cannot be empty`] }
  }

  if (isGlobPattern(userValue)) {
    const localPaths = globSync(userValue, { cwd, absolute: true }).sort()
    if (localPaths.length === 0) {
      return { errors: [`The glob "${userValue}" for input "${inputId}" did not match any files`] }
    }
    return {
      resolution: { id: inputId, kind: 'glob', source: 'local', userValue, localPaths },
      errors: []
    }
  }

  const resolvedPath = isAbsolute(userValue) ? userValue : join(cwd, userValue)
  if (!existsSync(resolvedPath)) {
    return { errors: [`The path for input "${inputId}" does not exist: ${resolvedPath}`] }
  }

  return {
    resolution: {
      id: inputId,
      kind: 'path',
      source: 'local',
      userValue,
      localPaths: [resolvedPath]
    },
    errors: []
  }
}
