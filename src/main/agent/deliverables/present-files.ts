import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { MAX_PRESENTED_FILES, type PresentedFile } from '../../../shared/presentedFileTypes'

const MAX_PATH_LENGTH = 4096
const MAX_DESCRIPTION_LENGTH = 160

function inside(root: string, target: string): boolean {
  const part = relative(root, target)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

export function validatePresentedFiles(cwd: string, value: unknown): PresentedFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRESENTED_FILES) {
    throw new Error(`Choose 1 to ${MAX_PRESENTED_FILES} existing files to present`)
  }
  const workspacePath = resolve(cwd)
  const root = realpathSync(workspacePath)
  const seen = new Set<string>()
  return value.map((item): PresentedFile => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Each presented file needs a path')
    }
    const record = item as Record<string, unknown>
    const requested = typeof record.path === 'string' ? record.path.trim() : ''
    if (!requested || requested.length > MAX_PATH_LENGTH) {
      throw new Error('Presented file path is missing or too long')
    }
    const target = resolve(workspacePath, requested)
    if (target !== workspacePath && !inside(workspacePath, target) && !inside(root, target)) {
      throw new Error(`Cannot present ${requested}: outside the current workspace`)
    }
    const info = lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Cannot present ${requested}: not a regular file`)
    }
    const realTarget = realpathSync(target)
    if (!inside(root, realTarget)) {
      throw new Error(`Cannot present ${requested}: outside the current workspace`)
    }
    if (seen.has(realTarget)) throw new Error(`Cannot present ${requested} twice`)
    seen.add(realTarget)
    const rawDescription = record.description
    if (rawDescription !== undefined && typeof rawDescription !== 'string') {
      throw new Error('Presented file description must be text')
    }
    const description = rawDescription?.replace(/\s+/g, ' ').trim()
    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`Presented file description exceeds ${MAX_DESCRIPTION_LENGTH} characters`)
    }
    return {
      path: realTarget,
      displayPath: relative(root, realTarget).split(sep).join('/'),
      bytes: info.size,
      ...(description ? { description } : {})
    }
  })
}
