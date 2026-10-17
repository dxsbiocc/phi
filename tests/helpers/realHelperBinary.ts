import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RealHelperBinary {
  readonly path: string
  readonly version: string
  readonly sha256: string
}

/**
 * Builds the real Go phi-helper from helper/ with the pinned toolchain
 * (scripts/helper-toolchain.mjs), the same way workspace-host-helper.test.ts does.
 */
export async function buildRealHelperBinary(outputDirectory: string): Promise<RealHelperBinary> {
  const path = join(outputDirectory, 'phi-helper')
  await execFileAsync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'helper-toolchain.mjs'), 'build', '-o', path, '.'],
    {
      cwd: join(process.cwd(), 'helper'),
      env: { ...process.env, CGO_ENABLED: '0' },
      maxBuffer: 16 * 1024 * 1024
    }
  )
  return {
    path,
    version: (await readFile(join(process.cwd(), 'helper', 'VERSION'), 'utf8')).trim(),
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  }
}
