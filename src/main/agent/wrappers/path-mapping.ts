import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { globSync } from 'glob'

import type { WrapperInputResolution } from './types'

const GLOB_CHAR_PATTERN = /[*?[\]{}]/

function isGlobPattern(value: string): boolean {
  return GLOB_CHAR_PATTERN.test(value)
}

export interface PathResolutionResult {
  resolution?: WrapperInputResolution
  errors: string[]
}

/**
 * Resolves one manifest input's user-provided value against the local
 * filesystem only (Phase 1 has no remote paths yet — `remotePaths` and
 * `containerPaths` on the result stay unset). Never throws: every failure
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
      resolution: { id: inputId, kind: 'glob', userValue, localPaths },
      errors: []
    }
  }

  const resolvedPath = isAbsolute(userValue) ? userValue : join(cwd, userValue)
  if (!existsSync(resolvedPath)) {
    return { errors: [`输入 "${inputId}" 指向的路径不存在: ${resolvedPath}`] }
  }

  return {
    resolution: { id: inputId, kind: 'path', userValue, localPaths: [resolvedPath] },
    errors: []
  }
}
