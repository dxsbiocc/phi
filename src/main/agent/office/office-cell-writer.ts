import { stat } from 'node:fs/promises'

import { officeCliEnv, runOfficeCli } from './office-driver'
import { cellWriteRequest, officeWriteStrategy } from './office-write-operation'
import { assertSuccessfulCellBatch, assertSuccessfulSave } from './office-write-parser'
import {
  OfficeWriteError,
  type OfficeCellEditParams,
  type OfficeWriteContext
} from './office-write-contract'

interface OfficeCellWriterDependencies {
  readonly run?: typeof runOfficeCli
  readonly inspectDraft?: (draftPath: string) => Promise<boolean>
}

const WRITE_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

export class OfficeCellWriter {
  private readonly run: typeof runOfficeCli
  private readonly inspectDraft: (draftPath: string) => Promise<boolean>

  constructor(dependencies: OfficeCellWriterDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
    this.inspectDraft = dependencies.inspectDraft ?? inspectDraft
  }

  async apply(context: OfficeWriteContext, params: OfficeCellEditParams): Promise<void> {
    const request = cellWriteRequest(params)
    const commands = JSON.stringify(
      officeWriteStrategy(request.operation).commands(request.operation)
    )
    const result = await this.run(
      context.binaryPath,
      ['batch', context.draftPath, '--commands', commands, '--json'],
      {
        timeoutMs: 30_000,
        signal: context.signal,
        onSpawn: () => context.onSpawn?.(),
        env: officeCliEnv(process.env, WRITE_ENV)
      }
    )
    assertSuccessfulCellBatch(result)
  }

  async save(context: OfficeWriteContext): Promise<void> {
    const result = await this.run(context.binaryPath, ['save', context.draftPath, '--json'], {
      timeoutMs: 30_000,
      signal: context.signal,
      env: officeCliEnv(process.env, WRITE_ENV)
    })
    assertSuccessfulSave(result)
    if (!(await this.inspectDraft(context.draftPath))) {
      throw new OfficeWriteError('save_failed', '内容已写入，但 Office 草稿文件状态异常')
    }
  }
}

async function inspectDraft(draftPath: string): Promise<boolean> {
  try {
    const value = await stat(draftPath)
    return value.isFile() && value.size > 0
  } catch {
    return false
  }
}
