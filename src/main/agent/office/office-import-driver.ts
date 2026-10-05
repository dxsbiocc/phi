import { officeCliEnv, runOfficeCli, type OfficeCliRunResult } from './office-driver'
import {
  OfficeImportError,
  type OfficeImportCellValue,
  type OfficeImportExecutionControl
} from './office-import-contract'
import type { OfficeImportWorkbookInput } from './office-import-files'
import { OFFICE_IMPORT_LIMITS } from './office-import-limits'
import { OfficeImportWorkbookVerifier } from './office-import-verify'
import { columnName } from './office-read-contract'
import type { OfficeBatchCommand } from './office-write-operation-types'
import { assertSuccessfulAtomicBatch, assertSuccessfulSave } from './office-write-parser'
import { fileOwnerPids } from './office-process-discovery'

export { OfficeImportWorkbookVerifier } from './office-import-verify'

interface OfficeImportDriverDependencies {
  readonly run?: typeof runOfficeCli
  readonly verifier?: OfficeImportWorkbookVerifier
  readonly owners?: typeof fileOwnerPids
}

const IMPORT_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

function importCommand(
  sheet: string,
  row: number,
  column: number,
  value: OfficeImportCellValue
): OfficeBatchCommand {
  return {
    command: 'set',
    path: `/${sheet}/${columnName(column)}${row}`,
    props: { value, type: typeof value === 'number' ? 'number' : 'string' }
  }
}

export function createOfficeImportBatches(
  sheet: string,
  values: readonly (readonly OfficeImportCellValue[])[]
): readonly (readonly OfficeBatchCommand[])[] {
  const batches: OfficeBatchCommand[][] = []
  let batch: OfficeBatchCommand[] = []
  let batchBytes = 2
  const flush = (): void => {
    if (batch.length === 0) return
    batches.push(batch)
    batch = []
    batchBytes = 2
  }
  values.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === '') return
      const command = importCommand(sheet, rowIndex + 1, columnIndex + 1, value)
      const commandBytes = Buffer.byteLength(JSON.stringify(command), 'utf8')
      const separatorBytes = batch.length > 0 ? 1 : 0
      if (
        batch.length >= OFFICE_IMPORT_LIMITS.maxBatchCells ||
        batchBytes + separatorBytes + commandBytes > OFFICE_IMPORT_LIMITS.maxBatchBytes
      ) {
        flush()
      }
      if (commandBytes + 2 > OFFICE_IMPORT_LIMITS.maxBatchBytes) {
        throw new OfficeImportError('import_too_large', '单个导入单元格超过批处理大小上限')
      }
      batch.push(command)
      batchBytes += (batch.length > 1 ? 1 : 0) + commandBytes
    })
  })
  flush()
  return Object.freeze(batches.map((commands) => Object.freeze(commands)))
}

function successfulJson(result: OfficeCliRunResult, operation: string): void {
  if (result.spawnError || result.timedOut || result.truncated || result.exitCode !== 0) {
    throw new OfficeImportError('import_failed', `${operation}失败`)
  }
  try {
    const value = JSON.parse(result.stdout) as { success?: unknown; warnings?: unknown }
    if (value.success !== true || (Array.isArray(value.warnings) && value.warnings.length > 0)) {
      throw new Error('unsuccessful')
    }
  } catch (error) {
    throw new OfficeImportError('import_failed', `${operation}返回无效结果`, undefined, {
      cause: error
    })
  }
}

export class OfficeImportWorkbookDriver {
  private readonly run: typeof runOfficeCli
  private readonly verifier: OfficeImportWorkbookVerifier
  private readonly owners: typeof fileOwnerPids

  constructor(dependencies: OfficeImportDriverDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
    this.verifier = dependencies.verifier ?? new OfficeImportWorkbookVerifier({ run: this.run })
    this.owners = dependencies.owners ?? fileOwnerPids
  }

  async prepare(
    binaryPath: string,
    input: OfficeImportWorkbookInput,
    control: OfficeImportExecutionControl = {}
  ): Promise<void> {
    try {
      await this.runSimple(
        binaryPath,
        ['create', input.draftPath, '--json'],
        '创建导入工作簿',
        control
      )
      await this.trackResident(input.draftPath, control)
      for (const batch of createOfficeImportBatches(input.sheet, input.values)) {
        await this.writeBatch(binaryPath, input.draftPath, batch, control)
      }
      await this.saveAndVerify(binaryPath, input, control)
    } catch (error) {
      if (control.signal?.aborted) {
        throw new OfficeImportError('import-cancelled', '已取消 CSV/TSV 导入', undefined, {
          cause: error
        })
      }
      throw error
    }
  }

  private async saveAndVerify(
    binaryPath: string,
    input: OfficeImportWorkbookInput,
    control: OfficeImportExecutionControl
  ): Promise<void> {
    const save = await this.run(binaryPath, ['save', input.draftPath, '--json'], {
      timeoutMs: 30_000,
      env: officeCliEnv(process.env, IMPORT_ENV),
      signal: control.signal
    })
    try {
      assertSuccessfulSave(save)
    } catch (error) {
      throw new OfficeImportError('import_failed', '导入工作簿保存失败', undefined, {
        cause: error
      })
    }
    await this.runSimple(
      binaryPath,
      ['validate', input.draftPath, '--json'],
      '导入工作簿校验',
      control
    )
    await this.verifier.verify(binaryPath, input.draftPath, input.sheet, input.values, control)
  }

  private async runSimple(
    binaryPath: string,
    args: readonly string[],
    operation: string,
    control: OfficeImportExecutionControl
  ): Promise<void> {
    const result = await this.run(binaryPath, args, {
      timeoutMs: 30_000,
      env: officeCliEnv(process.env, IMPORT_ENV),
      signal: control.signal
    })
    successfulJson(result, operation)
  }

  private async writeBatch(
    binaryPath: string,
    draftPath: string,
    batch: readonly OfficeBatchCommand[],
    control: OfficeImportExecutionControl
  ): Promise<void> {
    const result = await this.run(binaryPath, ['batch', draftPath, '--json'], {
      timeoutMs: 30_000,
      stdin: JSON.stringify(batch),
      env: officeCliEnv(process.env, IMPORT_ENV),
      signal: control.signal
    })
    try {
      assertSuccessfulAtomicBatch(result, batch.length)
    } catch (error) {
      throw new OfficeImportError('import_failed', '导入批次未能可靠写入', undefined, {
        cause: error
      })
    }
  }

  private async trackResident(
    draftPath: string,
    control: OfficeImportExecutionControl
  ): Promise<void> {
    if (!control.onResidentPid) return
    const deadline = Date.now() + 2_000
    while (!control.signal?.aborted && Date.now() < deadline) {
      const pids = await this.owners(draftPath)
      if (pids.length > 0) {
        pids.forEach((pid) => control.onResidentPid?.(pid))
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }
}
