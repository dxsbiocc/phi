import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isPathInsideRoot } from '../local-file-access'
import {
  loadOfficeOutputLog,
  type OfficeOutputLogState,
  type OfficeOutputRecord
} from './office-output-log'
import { OfficeSaveAsError } from './office-save-as-target'

export async function resolveRecordedOfficeOutput(
  draftPath: string,
  projectRoot: string,
  outputId: string,
  load: (draftPath: string) => Promise<OfficeOutputLogState> = loadOfficeOutputLog
): Promise<{ readonly path: string; readonly record: OfficeOutputRecord }> {
  let state: OfficeOutputLogState
  try {
    state = await load(draftPath)
  } catch {
    throw new OfficeSaveAsError('output_log_corrupt', 'Office 输出记录无法验证')
  }
  const record = state.outputs.find((entry) => entry.outputId === outputId)
  if (!record) throw integrityError('Office 输出记录不存在')
  const target = resolve(projectRoot, record.outputPath)
  if (!isPathInsideRoot(projectRoot, target)) {
    throw new OfficeSaveAsError('outside_project', 'Office 输出不在当前项目内')
  }
  const [realRoot, realTarget, stats] = await inspectOutput(projectRoot, target)
  if (stats.isSymbolicLink() || !stats.isFile() || !isPathInsideRoot(realRoot, realTarget)) {
    throw new OfficeSaveAsError('outside_project', 'Office 输出文件不可安全显示')
  }
  const bytes = await readFile(target).catch(() => {
    throw integrityError('Office 输出文件无法读取')
  })
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (stats.size !== record.size || bytes.length !== record.size || sha256 !== record.sha256) {
    throw integrityError('Office 输出文件内容与交付记录不一致')
  }
  return { path: target, record }
}

async function inspectOutput(
  projectRoot: string,
  target: string
): Promise<readonly [string, string, Awaited<ReturnType<typeof lstat>>]> {
  try {
    return await Promise.all([realpath(projectRoot), realpath(target), lstat(target)])
  } catch {
    throw integrityError('Office 输出文件不存在或无法安全检查')
  }
}

function integrityError(message: string): OfficeSaveAsError {
  return new OfficeSaveAsError('output_integrity_failed', message)
}
