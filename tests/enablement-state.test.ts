import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CORE_SKILL_NAMES,
  getEnablementPath,
  getEnablementSnapshot,
  isCoreSkill,
  isEnabled,
  readEnablementState,
  setEnabled,
  type EnablementLogger
} from '../src/main/agent/enablement'

interface TestLogger extends EnablementLogger {
  infos: Array<{ message: string; metadata?: Record<string, unknown> }>
  warnings: Array<{ message: string; metadata?: Record<string, unknown> }>
}

function createLogger(): TestLogger {
  const infos: TestLogger['infos'] = []
  const warnings: TestLogger['warnings'] = []
  return {
    infos,
    warnings,
    info(message, metadata) {
      infos.push({ message, metadata })
    },
    warn(message, metadata) {
      warnings.push({ message, metadata })
    }
  }
}

function withSandbox(callback: (sandbox: { root: string; agentDir: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-enablement-state-'))
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  try {
    callback({ root, agentDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeState(agentDir: string, value: unknown): void {
  const path = getEnablementPath(agentDir)
  mkdirSync(join(agentDir, 'state'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

test('source defaults keep only non-core bundled skills disabled', () => {
  withSandbox(({ agentDir }) => {
    const logger = createLogger()
    const options = { agentDir, logger }

    assert.deepEqual(CORE_SKILL_NAMES, ['create-wrapper'])
    assert.equal(isCoreSkill('create-wrapper'), true)
    assert.equal(isCoreSkill('nextflow'), false)
    assert.equal(isCoreSkill('scanpy'), false)
    assert.equal(isEnabled({ key: 'skill:create-wrapper', source: 'bundled' }, options), true)
    assert.equal(isEnabled({ key: 'skill:nextflow', source: 'installed-package' }, options), true)
    assert.equal(isEnabled({ key: 'skill:scanpy', source: 'bundled' }, options), false)
    assert.equal(isEnabled({ key: 'skill:scanpy', source: 'installed-package' }, options), true)
    assert.equal(isEnabled({ key: 'skill:mine', source: 'user' }, options), true)
    assert.equal(isEnabled({ key: 'skill:local', source: 'project' }, options), true)
    assert.equal(isEnabled({ key: 'skill:plugin-skill', source: 'plugin' }, options), true)
    assert.equal(isEnabled({ key: 'plugin:bundled-plugin', source: 'bundled' }, options), true)
    assert.equal(
      isEnabled({ key: 'plugin:installed-plugin', source: 'installed-package' }, options),
      true
    )
    assert.equal(isEnabled({ key: 'wrapper:fastqc', source: 'bundled' }, options), true)
    assert.equal(
      isEnabled({ key: 'wrapper:custom-tools', source: 'installed-package' }, options),
      true
    )
    assert.equal(isEnabled({ key: 'mcp:pubmed', source: 'installed-package' }, options), true)

    setEnabled('wrapper:fastqc', false, options)
    setEnabled('mcp:pubmed', false, options)
    assert.equal(isEnabled({ key: 'wrapper:fastqc', source: 'bundled' }, options), false)
    assert.equal(isEnabled({ key: 'mcp:pubmed', source: 'installed-package' }, options), false)
  })
})

test('project override wins over global override and null clears each scope', () => {
  withSandbox(({ root, agentDir }) => {
    const logger = createLogger()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir)

    setEnabled('skill:scanpy', true, { agentDir, logger })
    assert.equal(isEnabled({ key: 'skill:scanpy', source: 'bundled' }, { agentDir, logger }), true)

    setEnabled('skill:scanpy', false, { agentDir, logger, projectDir })
    assert.equal(
      isEnabled({ key: 'skill:scanpy', source: 'bundled' }, { agentDir, logger, projectDir }),
      false
    )
    assert.equal(isEnabled({ key: 'skill:scanpy', source: 'bundled' }, { agentDir, logger }), true)

    setEnabled('skill:scanpy', null, { agentDir, logger, projectDir })
    assert.equal(
      isEnabled({ key: 'skill:scanpy', source: 'bundled' }, { agentDir, logger, projectDir }),
      true
    )
    assert.deepEqual(readEnablementState({ agentDir, logger }).projects, {})

    setEnabled('skill:scanpy', null, { agentDir, logger })
    assert.equal(isEnabled({ key: 'skill:scanpy', source: 'bundled' }, { agentDir, logger }), false)
  })
})

test('project overrides are stored under the project real path', () => {
  withSandbox(({ root, agentDir }) => {
    const logger = createLogger()
    const projectDir = join(root, 'real-project')
    const projectAlias = join(root, 'project-alias')
    mkdirSync(projectDir)
    symlinkSync(projectDir, projectAlias)

    setEnabled('skill:scanpy', true, { agentDir, logger, projectDir: projectAlias })
    const state = readEnablementState({ agentDir, logger })
    assert.deepEqual(Object.keys(state.projects), [realpathSync(projectDir)])
    assert.equal(state.projects[realpathSync(projectDir)]['skill:scanpy'], true)

    const snapshot = getEnablementSnapshot({ agentDir, logger, projectDir: projectAlias })
    assert.equal(snapshot.projectPath, realpathSync(projectDir))
    assert.deepEqual(snapshot.project, { 'skill:scanpy': true })
  })
})

test('core authoring stays enabled while installed Nextflow honors stored and requested overrides', () => {
  withSandbox(({ root, agentDir }) => {
    const logger = createLogger()
    const projectDir = join(root, 'project')
    mkdirSync(projectDir)
    const projectPath = realpathSync(projectDir)
    writeState(agentDir, {
      version: 1,
      global: { 'skill:create-wrapper': false, 'skill:nextflow': false },
      projects: { [projectPath]: { 'skill:create-wrapper': false } }
    })

    assert.equal(
      isEnabled(
        { key: 'skill:create-wrapper', source: 'bundled' },
        { agentDir, logger, projectDir }
      ),
      true
    )
    assert.equal(
      isEnabled({ key: 'skill:nextflow', source: 'installed-package' }, { agentDir, logger }),
      false
    )
    assert.throws(
      () => setEnabled('skill:create-wrapper', false, { agentDir, logger }),
      /cannot be disabled/
    )
    setEnabled('skill:nextflow', false, { agentDir, logger, projectDir })
    assert.equal(
      isEnabled(
        { key: 'skill:nextflow', source: 'installed-package' },
        { agentDir, logger, projectDir }
      ),
      false
    )
  })
})

test('atomic updates preserve unknown item keys', () => {
  withSandbox(({ agentDir }) => {
    const logger = createLogger()
    writeState(agentDir, {
      version: 1,
      global: { 'wrapper:future': true, 'skill:scanpy': false },
      projects: {}
    })

    setEnabled('skill:pptx', true, { agentDir, logger })
    setEnabled('skill:scanpy', true, { agentDir, logger })

    const state = JSON.parse(readFileSync(getEnablementPath(agentDir), 'utf8')) as {
      global: Record<string, boolean>
    }
    assert.deepEqual(state.global, {
      'wrapper:future': true,
      'skill:scanpy': true,
      'skill:pptx': true
    })
    assert.deepEqual(readdirSync(join(agentDir, 'state')), ['enabled.json'])
  })
})

test('missing and malformed state read as empty and are logged', () => {
  withSandbox(({ agentDir }) => {
    const logger = createLogger()
    assert.deepEqual(readEnablementState({ agentDir, logger }), {
      version: 1,
      global: {},
      projects: {}
    })
    assert.match(logger.warnings[0].message, /missing/)

    mkdirSync(join(agentDir, 'state'), { recursive: true })
    writeFileSync(getEnablementPath(agentDir), '{broken', 'utf8')
    assert.deepEqual(readEnablementState({ agentDir, logger }), {
      version: 1,
      global: {},
      projects: {}
    })
    assert.match(logger.warnings[1].message, /invalid/)

    writeState(agentDir, { version: 1, global: { 'skill:scanpy': 'yes' }, projects: {} })
    assert.deepEqual(readEnablementState({ agentDir, logger }).global, {})
    assert.match(logger.warnings[2].message, /invalid/)
  })
})

test('invalid item keys, sources, and unavailable projects are rejected', () => {
  withSandbox(({ root, agentDir }) => {
    const logger = createLogger()
    assert.throws(
      () => isEnabled({ key: 'skill:Bad Name', source: 'bundled' }, { agentDir, logger }),
      /Invalid enablement item key/
    )
    for (const key of ['wrapper:Bad Name', 'mcp:a', 'unknown:valid-id']) {
      assert.throws(
        () => isEnabled({ key: key as 'wrapper:future', source: 'bundled' }, { agentDir, logger }),
        /Invalid enablement item key/
      )
    }
    assert.throws(
      () =>
        isEnabled({ key: 'skill:scanpy', source: 'unknown' as 'bundled' }, { agentDir, logger }),
      /Invalid enablement source/
    )
    assert.throws(
      () => setEnabled('skill:scanpy', true, { agentDir, logger, projectDir: join(root, 'gone') }),
      /ENOENT/
    )
  })
})

test('a project folder that no longer exists resolves to defaults instead of throwing', () => {
  withSandbox(({ agentDir }) => {
    const options = { agentDir, logger: createLogger(), projectDir: join(agentDir, 'gone') }
    assert.equal(isEnabled({ key: 'plugin:visualization', source: 'bundled' }, options), true)
    assert.equal(isEnabled({ key: 'skill:scanpy', source: 'bundled' }, options), false)
  })
})
