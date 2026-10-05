import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
  MAX_PRESENTED_FILES,
  type PresentedFile,
  type PresentedOfficeFile
} from '../../../shared/presentedFileTypes'

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

export function validateOfficePresentedFile(
  cwd: string,
  input: PresentedOfficeFile & { readonly path: string; readonly description?: string }
): PresentedFile {
  const description = input.description ?? officeDescription(input.kind)
  const [file] = validatePresentedFiles(cwd, [{ path: input.path, description }])
  return {
    ...file,
    office: {
      artifactId: input.artifactId,
      outputId: input.outputId,
      kind: input.kind,
      revision: input.revision,
      sha256: input.sha256,
      warnings: [...input.warnings],
      checks: { ...input.checks }
    }
  }
}

function officeDescription(kind: PresentedOfficeFile['kind']): string {
  if (kind === 'xlsx') return '经重新打开和内容检查的 Excel 表格'
  if (kind === 'docx') return '经重新打开和内容检查的 Word 文档'
  return '经重新打开和内容检查的 PowerPoint 演示文稿'
}
