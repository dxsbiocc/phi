import { officeCliEnv, runOfficeCli } from './office-driver'
import { addSheetSnapshot } from './office-sheet-contract'
import { parseOfficeSheetSnapshot } from './office-sheet-parser'
import type { OfficeWriteContext, OfficeWriteSnapshot } from './office-write-contract'

interface OfficeSheetReaderDependencies {
  readonly run?: typeof runOfficeCli
}

const READ_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

export class OfficeSheetReader {
  private readonly run: typeof runOfficeCli

  constructor(dependencies: OfficeSheetReaderDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
  }

  async read(context: OfficeWriteContext, addedSheet?: string): Promise<OfficeWriteSnapshot> {
    const result = await this.run(
      context.binaryPath,
      ['get', context.draftPath, '/', '--depth', '1', '--json'],
      {
        timeoutMs: 30_000,
        signal: context.signal,
        env: officeCliEnv(process.env, READ_ENV)
      }
    )
    const parsed = parseOfficeSheetSnapshot(result)
    return addSheetSnapshot(
      parsed.sheetNames,
      addedSheet === undefined ? undefined : parsed.emptySheetNames.includes(addedSheet)
    )
  }
}
