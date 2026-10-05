import { officeCliEnv, runOfficeCli } from './office-driver'
import { officeWriteStrategy } from './office-write-operation'
import {
  assertSuccessfulAtomicBatch,
  assertSuccessfulFormulaRestoreBatch
} from './office-write-parser'
import {
  OFFICE_WRITE_LIMITS,
  OfficeWriteError,
  type OfficeWriteBefore,
  type OfficeWriteContext,
  type OfficeWriteOperation
} from './office-write-contract'

interface OfficeBatchWriterDependencies {
  readonly run?: typeof runOfficeCli
}

const WRITE_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

export class OfficeBatchWriter {
  private readonly run: typeof runOfficeCli

  constructor(dependencies: OfficeBatchWriterDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
  }

  async apply(context: OfficeWriteContext, operation: OfficeWriteOperation): Promise<void> {
    const strategy = officeWriteStrategy(operation)
    const commands = strategy.commands(operation)
    await this.applyCommands(context, commands, false, strategy.assertBatchResult)
  }

  async restore(
    context: OfficeWriteContext,
    operation: OfficeWriteOperation,
    before: OfficeWriteBefore
  ): Promise<void> {
    const strategy = officeWriteStrategy(operation)
    if (!strategy.restoreCommands) {
      throw new OfficeWriteError('write_unknown', '写入前内容无法自动恢复')
    }
    await this.applyCommands(context, strategy.restoreCommands(operation, before), true)
  }

  private async applyCommands(
    context: OfficeWriteContext,
    commands: ReturnType<ReturnType<typeof officeWriteStrategy>['commands']>,
    formulaRestore = false,
    assertResult?: (result: Awaited<ReturnType<typeof runOfficeCli>>, expectedItems: number) => void
  ): Promise<void> {
    const body = JSON.stringify(commands)
    if (Buffer.byteLength(body, 'utf8') > OFFICE_WRITE_LIMITS.maxBatchBytes) {
      throw new OfficeWriteError(
        'range_too_large',
        '批处理命令体超过 256 KiB，请缩小范围或减少单元格文本'
      )
    }
    const result = await this.run(context.binaryPath, ['batch', context.draftPath, '--json'], {
      timeoutMs: 30_000,
      signal: context.signal,
      onSpawn: () => context.onSpawn?.(),
      stdin: body,
      env: officeCliEnv(process.env, WRITE_ENV)
    })
    if (assertResult) assertResult(result, commands.length)
    else if (formulaRestore) assertSuccessfulFormulaRestoreBatch(result, commands.length)
    else assertSuccessfulAtomicBatch(result, commands.length)
  }
}
