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
    errors.push('本地映射根必须是无 NUL 的绝对路径')
  }
  if (!isRemoteAbsolutePath(mapping.remoteRoot)) {
    errors.push('服务器映射根必须是无 NUL 的 POSIX 绝对路径')
  }
  return errors
}

export function parseWrapperInputReference(
  inputId: string,
  value: unknown,
  defaultSource: WrapperInputReference['source']
): { reference?: WrapperInputReference; errors: string[] } {
  const reference: WrapperInputReference | undefined =
    typeof value === 'string'
      ? { source: defaultSource, path: value }
      : value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).sort().join(',') === 'path,source' &&
          ((value as Record<string, unknown>).source === 'local' ||
            (value as Record<string, unknown>).source === 'remote') &&
          typeof (value as Record<string, unknown>).path === 'string'
        ? (value as WrapperInputReference)
        : undefined
  if (!reference) return { errors: [`输入 "${inputId}" 必须是路径或 {source, path} 引用`] }
  if (!reference.path.trim() || reference.path.includes('\0')) {
    return { errors: [`输入 "${inputId}" 不能为空或包含 NUL`] }
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
      : { errors: [`输入 "${inputId}" 的本机来源不能是远程 URL`] }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return { errors: [`输入 "${inputId}" 的 URL 类型暂不支持`] }
  }

  if (context.projectLocation?.kind === 'ssh') {
    if (source === 'local') return { errors: [`远程项目的输入 "${inputId}" 不能引用本机文件`] }
    const root = context.projectLocation.canonicalRoot
    const remotePath = isRemoteAbsolutePath(path)
      ? posix.normalize(path)
      : posix.resolve(root, path)
    if (!isWithinRemoteRoot(root, remotePath)) {
      return { errors: [`输入 "${inputId}" 超出远程项目目录: ${path}`] }
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
      return { errors: [`输入 "${inputId}" 引用本机路径，但没有配置本机→服务器路径映射`] }
    }
    const mappingErrors = validateInputPathMapping(context.mapping)
    if (mappingErrors.length > 0) return { errors: mappingErrors }
    const localPath = isAbsolute(path) ? resolve(path) : resolve(context.projectLocation.path, path)
    const localRoot = resolve(context.mapping.localRoot)
    if (!isWithinLocalRoot(localRoot, localPath)) {
      return { errors: [`输入 "${inputId}" 超出本机映射根: ${path}`] }
    }
    const suffix = relative(localRoot, localPath).split(sep).join('/')
    const remotePath = posix.resolve(context.mapping.remoteRoot, suffix)
    if (!isWithinRemoteRoot(context.mapping.remoteRoot, remotePath)) {
      return { errors: [`输入 "${inputId}" 超出服务器映射根: ${path}`] }
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
    return { errors: [`输入 "${inputId}" 需填写服务器绝对路径，或配置服务器映射根`] }
  }
  const remotePath = isRemoteAbsolutePath(path)
    ? posix.normalize(path)
    : remoteRoot
      ? posix.resolve(remoteRoot, path)
      : path
  if (remoteRoot && !isRemoteAbsolutePath(path) && !isWithinRemoteRoot(remoteRoot, remotePath)) {
    return { errors: [`输入 "${inputId}" 超出服务器映射根: ${path}`] }
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
      errors.push(`本机运行的输入 "${id}" 不能引用服务器文件`)
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
    return { errors: [`输入 "${inputId}" 不能为空`] }
  }

  if (isGlobPattern(userValue)) {
    const localPaths = globSync(userValue, { cwd, absolute: true }).sort()
    if (localPaths.length === 0) {
      return { errors: [`输入 "${inputId}" 的通配符 "${userValue}" 没有匹配到任何文件`] }
    }
    return {
      resolution: { id: inputId, kind: 'glob', source: 'local', userValue, localPaths },
      errors: []
    }
  }

  const resolvedPath = isAbsolute(userValue) ? userValue : join(cwd, userValue)
  if (!existsSync(resolvedPath)) {
    return { errors: [`输入 "${inputId}" 指向的路径不存在: ${resolvedPath}`] }
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
