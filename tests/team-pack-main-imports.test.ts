import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import test from 'node:test'

const FORBIDDEN_MAIN_IMPORTS = ['@oh-my-pi/pi-ai/auth-broker', '@oh-my-pi/pi-coding-agent'] as const

test('team-pack main-process paths do not import Bun-only auth modules', () => {
  const teamPackRoot = resolve('src/main/agent/team-pack')
  const ipcRoot = resolve('src/main/ipc')
  const files = [
    ...sourceFiles(teamPackRoot),
    ...readdirSync(ipcRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith('team-pack-') &&
          ['.ts', '.tsx'].includes(extname(entry.name))
      )
      .map((entry) => join(ipcRoot, entry.name))
  ]
  const violations = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8')
    return FORBIDDEN_MAIN_IMPORTS.filter((specifier) => source.includes(specifier)).map(
      (specifier) => `${relative(process.cwd(), file)} -> ${specifier}`
    )
  })

  assert.deepEqual(violations, [])
})

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!entry.isFile() || !['.ts', '.tsx'].includes(extname(entry.name))) return []
    return [path]
  })
}
