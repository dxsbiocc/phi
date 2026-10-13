import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkEngineBoundary } from '../scripts/check-engine-boundary.mjs'

type AllowlistEntry = {
  file: string
  specifiers: string[]
  purpose?: string
  plan?: string
}

type BoundaryFailure = {
  file: string
  specifier: string
  rule: string
  message: string
}

function withFixture(run: (repoRoot: string) => void): void {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'phi-engine-boundary-'))
  try {
    for (const directory of ['src', 'tests', 'scripts']) {
      mkdirSync(path.join(repoRoot, directory), { recursive: true })
    }
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

function entry(
  file: string,
  specifiers: string[],
  overrides: Partial<AllowlistEntry> = {}
): AllowlistEntry {
  return {
    file,
    specifiers,
    purpose: 'Fixture dependency for the boundary checker',
    plan: 'remove',
    ...overrides
  }
}

function failuresFor(repoRoot: string, entries: AllowlistEntry[] = []): BoundaryFailure[] {
  return checkEngineBoundary({ repoRoot, allowlist: { entries } })
}

test('allows an allowlisted OMP reference outside the engine directory', () => {
  withFixture((repoRoot) => {
    const file = 'src/main/agent/tool.ts'
    const specifier = '@oh-my-pi/pi-coding-agent'
    writeFixture(repoRoot, file, `import type { CustomTool } from '${specifier}'\n`)

    assert.deepEqual(failuresFor(repoRoot, [entry(file, [specifier])]), [])
  })
})

test('rejects a new OMP reference outside the engine directory', () => {
  withFixture((repoRoot) => {
    const file = 'src/main/agent/new-tool.ts'
    const specifier = '@oh-my-pi/pi-coding-agent'
    writeFixture(repoRoot, file, `import { createAgentSession } from '${specifier}'\n`)

    assert.deepEqual(failuresFor(repoRoot), [
      {
        file,
        specifier,
        rule: 'outside-engine-unallowlisted',
        message: 'OMP module references outside src/main/agent/engine/ must be allowlisted.'
      }
    ])
  })
})

test('rejects only the newly added unlisted specifier in an allowlisted file', () => {
  withFixture((repoRoot) => {
    const file = 'src/main/agent/tool.ts'
    const listed = '@oh-my-pi/pi-coding-agent'
    const unlisted = '@oh-my-pi/pi-coding-agent/mcp/client'
    writeFixture(
      repoRoot,
      file,
      `import type { CustomTool } from '${listed}'\nimport { connectToServer } from '${unlisted}'\n`
    )

    assert.deepEqual(failuresFor(repoRoot, [entry(file, [listed])]), [
      {
        file,
        specifier: unlisted,
        rule: 'outside-engine-unallowlisted',
        message: 'OMP module references outside src/main/agent/engine/ must be allowlisted.'
      }
    ])
  })
})

test('rejects an allowlist entry whose file is missing', () => {
  withFixture((repoRoot) => {
    const file = 'src/main/agent/missing.ts'
    const specifier = '@oh-my-pi/pi-coding-agent'

    assert.deepEqual(failuresFor(repoRoot, [entry(file, [specifier])]), [
      {
        file,
        specifier,
        rule: 'stale-file',
        message: 'Allowlist file does not exist; delete this entry.'
      }
    ])
  })
})

test('rejects an allowlisted specifier the file no longer references', () => {
  withFixture((repoRoot) => {
    const file = 'src/main/agent/tool.ts'
    const specifier = '@oh-my-pi/pi-coding-agent'
    writeFixture(repoRoot, file, `const packageName = '${specifier}'\n`)

    assert.deepEqual(failuresFor(repoRoot, [entry(file, [specifier])]), [
      {
        file,
        specifier,
        rule: 'stale-specifier',
        message: 'File no longer references this specifier; delete it from the allowlist.'
      }
    ])
  })
})

test('allows package roots inside the engine and gates internal subpaths', () => {
  withFixture((repoRoot) => {
    const file = 'src/main/agent/engine/session.ts'
    const rootSpecifier = '@oh-my-pi/pi-coding-agent'
    const internalSpecifier = '@oh-my-pi/pi-coding-agent/mcp/client'
    writeFixture(repoRoot, file, `import { createAgentSession } from '${rootSpecifier}'\n`)
    assert.deepEqual(failuresFor(repoRoot), [])

    writeFixture(
      repoRoot,
      file,
      `import { createAgentSession } from '${rootSpecifier}'\nimport { connectToServer } from '${internalSpecifier}'\n`
    )
    assert.deepEqual(failuresFor(repoRoot), [
      {
        file,
        specifier: internalSpecifier,
        rule: 'engine-internal-subpath-unallowlisted',
        message: 'OMP internal subpaths inside src/main/agent/engine/ must be allowlisted.'
      }
    ])
    assert.deepEqual(failuresFor(repoRoot, [entry(file, [internalSpecifier])]), [])
  })
})

test('detects every supported module-reference syntax, including multiline imports', () => {
  withFixture((repoRoot) => {
    const file = 'src/references.ts'
    writeFixture(
      repoRoot,
      file,
      [
        "import { one } from '@oh-my-pi/pkg/import'",
        "import type { Two } from '@oh-my-pi/pkg/import-type'",
        "import '@oh-my-pi/pkg/side-effect'",
        "export { three } from '@oh-my-pi/pkg/export'",
        "export type { Four } from '@oh-my-pi/pkg/export-type'",
        "export * from '@oh-my-pi/pkg/export-all'",
        "const dynamic = import('@oh-my-pi/pkg/dynamic')",
        "const required = require('@oh-my-pi/pkg/require')",
        "import assigned = require('@oh-my-pi/pkg/import-equals')",
        'const backtickDynamic = import(`@oh-my-pi/pkg/backtick-dynamic`)',
        'const backtickRequired = require(`@oh-my-pi/pkg/backtick-require`)',
        'import {',
        '  multiline',
        "} from '@oh-my-pi/pkg/multiline'",
        'void [one, dynamic, required, assigned, multiline, backtickDynamic, backtickRequired]'
      ].join('\n')
    )

    assert.deepEqual(
      failuresFor(repoRoot).map(({ specifier }) => specifier),
      [
        '@oh-my-pi/pkg/backtick-dynamic',
        '@oh-my-pi/pkg/backtick-require',
        '@oh-my-pi/pkg/dynamic',
        '@oh-my-pi/pkg/export',
        '@oh-my-pi/pkg/export-all',
        '@oh-my-pi/pkg/export-type',
        '@oh-my-pi/pkg/import',
        '@oh-my-pi/pkg/import-equals',
        '@oh-my-pi/pkg/import-type',
        '@oh-my-pi/pkg/multiline',
        '@oh-my-pi/pkg/require',
        '@oh-my-pi/pkg/side-effect'
      ]
    )
  })
})

test('ignores OMP strings that are not module references', () => {
  withFixture((repoRoot) => {
    writeFixture(
      repoRoot,
      'src/non-references.ts',
      [
        "const packageName = '@oh-my-pi/pi-coding-agent'",
        "const packagePath = 'node_modules/@oh-my-pi/pi-coding-agent/index.js'",
        "// import { ignored } from '@oh-my-pi/pi-coding-agent'",
        'void [packageName, packagePath]'
      ].join('\n')
    )

    assert.deepEqual(failuresFor(repoRoot), [])
  })
})

test('scans every configured source extension and skips dot and node_modules directories', () => {
  withFixture((repoRoot) => {
    const extensions = ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs']
    for (const extension of extensions) {
      writeFixture(
        repoRoot,
        `scripts/reference.${extension}`,
        `require('@oh-my-pi/pkg/${extension}')\n`
      )
    }
    writeFixture(repoRoot, 'src/.generated/ignored.ts', "import '@oh-my-pi/pkg/dot-directory'\n")
    writeFixture(
      repoRoot,
      'tests/node_modules/ignored.js',
      "require('@oh-my-pi/pkg/node-modules')\n"
    )

    assert.deepEqual(
      failuresFor(repoRoot).map(({ specifier }) => specifier),
      extensions.map((extension) => `@oh-my-pi/pkg/${extension}`).sort()
    )
  })
})

test('allowlist validation rejects duplicate file entries', () => {
  withFixture((repoRoot) => {
    const file = 'src/tool.ts'
    const specifier = '@oh-my-pi/pkg'
    writeFixture(repoRoot, file, `import '${specifier}'\n`)
    const failures = failuresFor(repoRoot, [entry(file, [specifier]), entry(file, [specifier])])

    assert.equal(failures.filter(({ rule }) => rule === 'allowlist-duplicate-file').length, 1)
  })
})

test('allowlist validation rejects empty specifier lists', () => {
  withFixture((repoRoot) => {
    const file = 'src/tool.ts'
    writeFixture(repoRoot, file, 'export {}\n')

    assert.equal(
      failuresFor(repoRoot, [entry(file, [])]).filter(
        ({ rule }) => rule === 'allowlist-empty-specifiers'
      ).length,
      1
    )
  })
})

test('allowlist validation rejects duplicate specifiers within an entry', () => {
  withFixture((repoRoot) => {
    const file = 'src/tool.ts'
    const specifier = '@oh-my-pi/pkg'
    writeFixture(repoRoot, file, `import '${specifier}'\n`)

    assert.equal(
      failuresFor(repoRoot, [entry(file, [specifier, specifier])]).filter(
        ({ rule }) => rule === 'allowlist-duplicate-specifier'
      ).length,
      1
    )
  })
})

test('allowlist validation rejects non-OMP specifiers', () => {
  withFixture((repoRoot) => {
    const file = 'src/tool.ts'
    writeFixture(repoRoot, file, "import 'other-package'\n")

    assert.equal(
      failuresFor(repoRoot, [entry(file, ['other-package'])]).filter(
        ({ rule }) => rule === 'allowlist-invalid-specifier'
      ).length,
      1
    )
  })
})

test('allowlist validation rejects missing and empty purposes separately', () => {
  withFixture((repoRoot) => {
    const file = 'src/tool.ts'
    const specifier = '@oh-my-pi/pkg'
    writeFixture(repoRoot, file, `import '${specifier}'\n`)

    for (const purpose of [undefined, '   ']) {
      const failures = failuresFor(repoRoot, [entry(file, [specifier], { purpose })])
      assert.equal(failures.filter(({ rule }) => rule === 'allowlist-missing-purpose').length, 1)
    }
  })
})

test('allowlist validation rejects plans other than remove or keep', () => {
  withFixture((repoRoot) => {
    const file = 'src/tool.ts'
    const specifier = '@oh-my-pi/pkg'
    writeFixture(repoRoot, file, `import '${specifier}'\n`)

    assert.equal(
      failuresFor(repoRoot, [entry(file, [specifier], { plan: 'later' })]).filter(
        ({ rule }) => rule === 'allowlist-invalid-plan'
      ).length,
      1
    )
  })
})

test('the real repository satisfies the engine boundary allowlist', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const allowlist = JSON.parse(
    readFileSync(new URL('../scripts/engine-boundary-allowlist.json', import.meta.url), 'utf8')
  )

  assert.deepEqual(checkEngineBoundary({ repoRoot, allowlist }), [])
})
