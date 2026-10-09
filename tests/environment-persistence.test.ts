import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import * as environmentTypes from '../src/shared/environmentTypes'

function interruptedStore(filesystem: Partial<typeof fs>): {
  dismissEnvironmentSummary: (agentDir: string) => unknown
} {
  const code = ts.transpileModule(fs.readFileSync('src/main/agent/environment/store.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = { dismissEnvironmentSummary: (): unknown => undefined }
  new Function('require', 'exports', code)((name: string) => {
    if (name === 'node:fs') return { ...fs, ...filesystem }
    if (name === 'node:path') return { join }
    if (name === 'node:crypto') return { randomUUID: () => 'interrupted-fixture' }
    if (name === '../../../shared/environmentTypes') return environmentTypes
    if (name === '../runtime-paths' || name === './detect') return {}
    throw new Error(`Unexpected dependency: ${name}`)
  }, exports)
  return exports
}

for (const interruption of ['write', 'rename'] as const) {
  test(`an interrupted environment ${interruption} preserves the last complete snapshot`, () => {
    const agentDir = fs.mkdtempSync(join(tmpdir(), 'phi-environment-persist-'))
    const path = join(agentDir, 'environment.json')
    const previous = JSON.stringify({
      firstScanCompleted: true,
      summaryDismissed: false,
      scannedAt: '2026-10-09T00:00:00Z',
      customPaths: {},
      tools: [{ id: 'docker', label: 'Docker', status: 'missing', source: 'none' }],
      hostDependencies: [],
      hostTools: []
    })
    fs.writeFileSync(path, previous)
    const store = interruptedStore(
      interruption === 'write'
        ? {
            writeFileSync: ((target: fs.PathOrFileDescriptor) => {
              fs.writeFileSync(target, '{"partial":')
              throw new Error('interrupted write')
            }) as typeof fs.writeFileSync
          }
        : {
            renameSync: () => {
              throw new Error('interrupted rename')
            }
          }
    )
    try {
      assert.throws(() => store.dismissEnvironmentSummary(agentDir), /interrupted/)
      assert.equal(fs.readFileSync(path, 'utf8'), previous)
      assert.deepEqual(fs.readdirSync(agentDir), ['environment.json'])
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true })
    }
  })
}
