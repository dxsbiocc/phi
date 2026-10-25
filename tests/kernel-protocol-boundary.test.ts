import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkKernelBoundary } from '../scripts/check-engine-boundary.mjs'

type BoundaryFailure = {
  file: string
  specifier: string
  rule: string
  message: string
}

function withFixture(run: (repoRoot: string) => void): void {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'phi-kernel-boundary-'))
  try {
    run(repoRoot)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
}

function writeFixture(repoRoot: string, relativePath: string, contents: string): void {
  const filePath = path.join(repoRoot, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, contents)
}

function failuresFor(repoRoot: string): BoundaryFailure[] {
  return checkKernelBoundary({ repoRoot })
}

test('shared kernel protocol accepts only zod and imports contained within its directory', () => {
  withFixture((repoRoot) => {
    writeFixture(
      repoRoot,
      'src/shared/kernel-protocol/index.ts',
      "import { z } from 'zod'\nexport { frame } from './frames.js'\nvoid z\n"
    )
    writeFixture(repoRoot, 'src/shared/kernel-protocol/frames.ts', 'export const frame = {}\n')

    assert.deepEqual(failuresFor(repoRoot), [])
  })
})

test('shared kernel protocol rejects platform, UI, OMP, and arbitrary package imports', () => {
  withFixture((repoRoot) => {
    const cases = [
      ['node:path', 'node:path'],
      ['electron', 'electron'],
      ['react', 'react'],
      ['@oh-my-pi/pi-coding-agent', '@oh-my-pi/pi-coding-agent'],
      ['main', '../../main/index.js'],
      ['renderer', '../../renderer/src/App.js'],
      ['preload', '../../preload/index.js'],
      ['package', 'some-package']
    ] as const

    for (const [name, specifier] of cases) {
      writeFixture(
        repoRoot,
        `src/shared/kernel-protocol/${name}.ts`,
        `import value from '${specifier}'\nvoid value\n`
      )
    }

    const failures = failuresFor(repoRoot)
    assert.equal(failures.length, cases.length)
    assert.deepEqual(
      failures
        .map(({ specifier, rule }) => [specifier, rule])
        .sort(([left], [right]) => left.localeCompare(right)),
      cases
        .map(([, specifier]) => [specifier, 'shared-protocol-import-forbidden'])
        .sort(([left], [right]) => left.localeCompare(right))
    )
  })
})

test('kernel rejects Electron, React, renderer, preload, and main IPC dependencies', () => {
  withFixture((repoRoot) => {
    const cases = [
      ['electron', 'electron', 'kernel-electron-import-forbidden'],
      ['react', 'react/jsx-runtime', 'kernel-react-import-forbidden'],
      ['renderer-alias', '@renderer/App', 'kernel-renderer-import-forbidden'],
      ['renderer-relative', '../renderer/src/App.js', 'kernel-renderer-import-forbidden'],
      ['preload', '../preload/index.js', 'kernel-preload-import-forbidden'],
      ['main-ipc', '../main/ipc/session.js', 'kernel-main-ipc-import-forbidden']
    ] as const

    for (const [name, specifier] of cases) {
      writeFixture(
        repoRoot,
        `src/kernel/${name}.ts`,
        `import value from '${specifier}'\nvoid value\n`
      )
    }

    const failures = failuresFor(repoRoot)
    assert.equal(failures.length, cases.length)
    for (const [, specifier, rule] of cases) {
      assert.ok(
        failures.some((failure) => failure.specifier === specifier && failure.rule === rule)
      )
    }
  })
})

test('kernel permits transport-neutral dependencies and confines OMP imports to its adapter', () => {
  withFixture((repoRoot) => {
    writeFixture(
      repoRoot,
      'src/kernel/protocol/core.ts',
      "import path from 'node:path'\nvoid path\n"
    )
    writeFixture(
      repoRoot,
      'src/kernel/omp/version.ts',
      "import type { AgentSession } from '@oh-my-pi/pi-coding-agent'\nexport type Session = AgentSession\n"
    )
    assert.deepEqual(failuresFor(repoRoot), [])

    writeFixture(
      repoRoot,
      'src/kernel/protocol/forbidden.ts',
      "import type { AgentSession } from '@oh-my-pi/pi-coding-agent'\nexport type Session = AgentSession\n"
    )
    assert.deepEqual(failuresFor(repoRoot), [
      {
        file: 'src/kernel/protocol/forbidden.ts',
        specifier: '@oh-my-pi/pi-coding-agent',
        rule: 'kernel-omp-import-outside-adapter',
        message: 'OMP module references under src/kernel/ are allowed only in src/kernel/omp/.'
      }
    ])
  })
})

test('kernel boundary checker recognizes every supported module-reference syntax', () => {
  withFixture((repoRoot) => {
    writeFixture(
      repoRoot,
      'src/kernel/references.ts',
      [
        "import value from 'electron'",
        "export { value as other } from 'react'",
        "const dynamic = import('@renderer/dynamic', {})",
        "const required = require('../preload/index.js')",
        "const resolved = require.resolve('@oh-my-pi/pi-coding-agent/internal')",
        "const metaResolved = import.meta.resolve('@oh-my-pi/pi-coding-agent/meta')",
        "import assigned = require('../main/ipc/assigned.js')",
        "type IpcType = import('../main/ipc/type-only.js').IpcType",
        'void [value, dynamic, required, resolved, metaResolved, assigned]',
        'void (null as IpcType | null)'
      ].join('\n')
    )

    assert.deepEqual(
      failuresFor(repoRoot).map(({ specifier }) => specifier),
      [
        '../main/ipc/assigned.js',
        '../main/ipc/type-only.js',
        '../preload/index.js',
        '@oh-my-pi/pi-coding-agent/internal',
        '@oh-my-pi/pi-coding-agent/meta',
        '@renderer/dynamic',
        'electron',
        'react'
      ]
    )
  })
})

test('the real repository satisfies the kernel boundary rules', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  assert.deepEqual(checkKernelBoundary({ repoRoot }), [])
})
