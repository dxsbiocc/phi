import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { PHI_PLATFORMS } from '../src/main/agent/envs/contract'
import {
  PLUGIN_CONTRACT_VERSION,
  pluginManifestSchema,
  type PhiPluginManifest
} from '../src/main/agent/plugins/phi-package'
import {
  validatePlugin,
  type PluginProblem,
  type PluginValidationResult
} from '../src/main/agent/plugins/validate'
import { copyMinimal } from './helpers/fakeEnvironment'

const REPO_ROOT = join(import.meta.dirname, '..')
const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function validManifest(): PhiPluginManifest {
  return {
    schemaVersion: 1,
    id: 'demo-plugin',
    type: 'plugin',
    version: '1.2.3-beta.1',
    title: 'Demo plugin',
    summary: 'A plugin fixture for contract validation.',
    toolPrefix: 'demo',
    components: {
      agents: ['agents/Demo.md'],
      skills: ['skills/demo-skill']
    },
    environments: {
      demo: { spec: 'environments/demo/environment.yml' }
    }
  }
}

function agentDocument(options?: { environment?: string; extra?: string }): string {
  return `---
name: Demo
description: Demonstrates plugin validation.
tools: [read, bash]
skills: [demo-skill]
environment: ${options?.environment ?? 'plugin:demo'}
${options?.extra ?? ''}---
You are a test specialist.
`
}

function skillDocument(options?: {
  environment?: string
  attachTo?: string
  extraPhi?: string
}): string {
  return `---
name: demo-skill
description: Demonstrates plugin skill validation.
phi:
  environment: ${options?.environment ?? 'plugin:demo'}
  attachTo: ${options?.attachTo ?? '[Demo]'}
${options?.extraPhi ?? ''}  scripts:
    - name: run
      description: Run a fixture script.
      run: [python, ./scripts/run.py]
      args:
        type: object
        properties: {}
        additionalProperties: false
      approval: read
---
Use the fixture script.
`
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function pluginFixture(
  mutate?: (manifest: PhiPluginManifest) => void,
  files?: Record<string, string>
): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-plugin-validate-'))
  roots.push(root)
  const dir = join(root, 'demo-plugin')
  mkdirSync(dir, { recursive: true })
  const manifest = validManifest()
  mutate?.(manifest)
  write(join(dir, 'phi-package.yaml'), stringifyYaml(manifest))
  write(join(dir, 'agents', 'Demo.md'), agentDocument())
  write(join(dir, 'skills', 'demo-skill', 'SKILL.md'), skillDocument())
  write(join(dir, 'skills', 'demo-skill', 'scripts', 'run.py'), 'print({})\n')
  copyMinimal(join(dir, 'environments', 'demo'), 'demo')
  for (const [relativePath, content] of Object.entries(files ?? {})) {
    write(join(dir, relativePath), content)
  }
  return dir
}

function texts(problems: PluginProblem[]): string[] {
  return problems.map((problem) => `${problem.path}: ${problem.message}`)
}

function assertValid(dir: string): PluginValidationResult {
  const result = validatePlugin(dir)
  assert.equal(result.ok, true, texts(result.errors).join('\n'))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.ok(result.plugin)
  return result
}

function assertInvalid(dir: string, patterns: RegExp[]): PluginValidationResult {
  const result = validatePlugin(dir)
  assert.equal(result.ok, false)
  assert.equal(result.plugin, undefined)
  const errors = texts(result.errors)
  for (const pattern of patterns) {
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `${pattern} not in\n${errors.join('\n')}`
    )
  }
  assert.ok(result.errors.every((problem) => problem.level === 'error'))
  assert.ok(result.warnings.every((problem) => problem.level === 'warning'))
  return result
}

test('the runtime schema is an exact copy of the frozen published schema', () => {
  assert.equal(PLUGIN_CONTRACT_VERSION, '1.1.0')
  const published = JSON.parse(
    readFileSync(join(REPO_ROOT, 'docs', 'contracts', 'plugin.schema.json'), 'utf8')
  ) as unknown
  assert.deepEqual(pluginManifestSchema, published)
})

test('the manifest accepts the package contract distribution fields', () => {
  const dir = pluginFixture((manifest) => {
    manifest.minAppVersion = '0.9.0'
    manifest.requires = { coreTools: ['skill_run', 'env_request'] }
    manifest.dependsOn = [
      { id: 'shared-skill', type: 'skill', version: '^1.2.0' },
      { id: 'base-plugin', type: 'plugin', version: '>=2.0.0 <3' }
    ]
    manifest.files = 'files.json'
  })

  const result = assertValid(dir)
  assert.equal(result.plugin?.manifest.minAppVersion, '0.9.0')
  assert.deepEqual(result.plugin?.manifest.requires?.coreTools, ['skill_run', 'env_request'])
  assert.deepEqual(result.plugin?.manifest.dependsOn, [
    { id: 'shared-skill', type: 'skill', version: '^1.2.0' },
    { id: 'base-plugin', type: 'plugin', version: '>=2.0.0 <3' }
  ])
  assert.equal(result.plugin?.manifest.files, 'files.json')
})

test('the manifest validates every package contract distribution field', () => {
  const dir = pluginFixture()
  const document = {
    ...validManifest(),
    minAppVersion: '01.0.0',
    requires: {
      coreTools: ['Skill-Run', 'Skill-Run'],
      extra: true
    },
    dependsOn: [
      { id: 'Bad_ID', type: 'wrapper', version: '', extra: true },
      { id: 'missing-fields' }
    ],
    files: 'other.json'
  }
  write(join(dir, 'phi-package.yaml'), stringifyYaml(document))

  assertInvalid(dir, [
    /^minAppVersion:/,
    /^requires\.coreTools:/,
    /^requires\.coreTools\[0\]:/,
    /^requires\.extra:/,
    /^dependsOn\[0\]\.id:/,
    /^dependsOn\[0\]\.type:/,
    /^dependsOn\[0\]\.version:/,
    /^dependsOn\[0\]\.extra:/,
    /^dependsOn\[1\]\.type: is required/,
    /^dependsOn\[1\]\.version: is required/,
    /^files:/
  ])
})

test('the manifest rejects a non-empty dependency version that is not a semver range', () => {
  const dir = pluginFixture((manifest) => {
    manifest.dependsOn = [{ id: 'shared-skill', type: 'skill', version: 'not a range' }]
  })
  assertInvalid(dir, [
    /^dependsOn\[0\]\.version: 'not a range' is not a valid semantic version range/
  ])
})

test('a complete plugin returns its validated components and environments', () => {
  const dir = pluginFixture()
  const result = assertValid(dir)
  assert.equal(result.plugin?.manifest.id, 'demo-plugin')
  assert.equal(result.plugin?.manifest.version, '1.2.3-beta.1')
  assert.deepEqual(
    result.plugin?.agents.map((agent) => agent.name),
    ['Demo']
  )
  assert.deepEqual(
    result.plugin?.skills.map((skill) => skill.name),
    ['demo-skill']
  )
  assert.equal(result.plugin?.environments.demo.environment.name, 'demo')
  assert.deepEqual(Object.keys(result.plugin?.environments.demo.locks ?? {}), PHI_PLATFORMS)
})

test('phi-package.yaml is required, valid YAML, and a mapping', () => {
  const missing = pluginFixture()
  rmSync(join(missing, 'phi-package.yaml'))
  assertInvalid(missing, [/phi-package\.yaml: cannot read/])

  const malformed = pluginFixture()
  write(join(malformed, 'phi-package.yaml'), ': [\n')
  assertInvalid(malformed, [/phi-package\.yaml: YAML parse error/])

  const sequence = pluginFixture()
  write(join(sequence, 'phi-package.yaml'), '- plugin\n')
  assertInvalid(sequence, [/phi-package\.yaml must be a YAML mapping/])
})

test('the manifest schema rejects missing and unknown fields', () => {
  const missing = pluginFixture()
  write(join(missing, 'phi-package.yaml'), '{}\n')
  assertInvalid(missing, [
    /^schemaVersion: is required/,
    /^id: is required/,
    /^type: is required/,
    /^version: is required/,
    /^title: is required/,
    /^summary: is required/,
    /^toolPrefix: is required/,
    /^components: is required/
  ])

  const unknown = pluginFixture()
  const document = { ...validManifest(), futureField: true }
  write(join(unknown, 'phi-package.yaml'), stringifyYaml(document))
  assertInvalid(unknown, [/^futureField: unknown property 'futureField'/])
})

test('the manifest schema enforces every field and component-path rule', () => {
  const dir = pluginFixture()
  const document = {
    schemaVersion: 2,
    id: 'Bad_ID',
    type: 'skill',
    version: '01.2',
    title: '',
    summary: 'x'.repeat(301),
    toolPrefix: 'Bad_prefix',
    components: {
      agents: ['agents/not-pascal.md', 'agents/not-pascal.md'],
      skills: ['skills/Bad_Name', 'skills/Bad_Name'],
      extra: true
    },
    environments: {
      Bad_Name: { spec: 'outside/environment.yml', extra: true }
    }
  }
  write(join(dir, 'phi-package.yaml'), stringifyYaml(document))
  assertInvalid(dir, [
    /^schemaVersion:/,
    /^id:/,
    /^type:/,
    /^version:/,
    /^title:/,
    /^summary:/,
    /^toolPrefix:/,
    /^components\.extra:/,
    /^components\.agents:/,
    /^components\.agents\[0\]:/,
    /^components\.skills:/,
    /^components\.skills\[0\]:/,
    /^environments\.Bad_Name:/,
    /^environments\.Bad_Name\.spec:/,
    /^environments\.Bad_Name\.extra:/
  ])
})

test('components require at least one agent or skill', () => {
  const dir = pluginFixture((manifest) => {
    manifest.components = {}
  })
  rmSync(join(dir, 'agents'), { recursive: true })
  rmSync(join(dir, 'skills'), { recursive: true })
  assertInvalid(dir, [/^components: at least one agent or skill is required/])
})

test('reserved v1 directories are rejected', () => {
  for (const reserved of ['mcp', 'wrappers', 'orchestrator']) {
    const dir = pluginFixture()
    mkdirSync(join(dir, reserved))
    assertInvalid(dir, [new RegExp(`^${reserved}: '${reserved}' is reserved`)])
  }
})

test('listed components must exist with the right kind', () => {
  const missingAgent = pluginFixture()
  rmSync(join(missingAgent, 'agents', 'Demo.md'))
  assertInvalid(missingAgent, [/^agents\/Demo\.md: listed file does not exist/])

  const missingSkill = pluginFixture()
  rmSync(join(missingSkill, 'skills', 'demo-skill'), { recursive: true })
  assertInvalid(missingSkill, [/^skills\/demo-skill: listed directory does not exist/])
})

test('nothing directly under agents or skills may be left unlisted', () => {
  const dir = pluginFixture(undefined, {
    'agents/Extra.md': agentDocument(),
    'skills/extra-skill/SKILL.md': skillDocument()
  })
  assertInvalid(dir, [
    /^agents\/Extra\.md: agents\/Extra\.md is not listed in components\.agents/,
    /^skills\/extra-skill: skills\/extra-skill is not listed in components\.skills/
  ])
})

test('macOS Finder metadata under agents or skills is not an unlisted component', () => {
  const dir = pluginFixture(undefined, {
    'agents/.DS_Store': 'junk',
    'skills/.DS_Store': 'junk'
  })
  assertValid(dir)
})

test('environment declarations must use their own canonical spec path', () => {
  const dir = pluginFixture((manifest) => {
    manifest.environments = {
      demo: { spec: 'environments/other/environment.yml' }
    }
  })
  assertInvalid(dir, [
    /^environments\.demo\.spec: spec for environment 'demo' must be environments\/demo\/environment\.yml/,
    /^environments\/other\/environment\.yml: environment spec does not exist/
  ])
})

test('environment specs are parsed and must name their manifest environment', () => {
  const invalid = pluginFixture(undefined, {
    'environments/demo/environment.yml': 'name: demo\nchannels: []\ndependencies: []\n'
  })
  assertInvalid(invalid, [/^environments\/demo\/environment\.yml: .*fewer than 1 item/])

  const mismatched = pluginFixture(undefined, {
    'environments/demo/environment.yml':
      'name: other\nchannels: [conda-forge]\ndependencies: [python=3.12]\n'
  })
  assertInvalid(mismatched, [
    /^environments\/demo\/environment\.yml: environment spec name 'other' must equal manifest name 'demo'/
  ])
})

test('every shipped platform needs a valid explicit lock', () => {
  const missing = pluginFixture()
  const missingPlatform = PHI_PLATFORMS[0]
  rmSync(join(missing, 'environments', 'demo', 'locks', `${missingPlatform}.txt`))
  assertInvalid(missing, [
    new RegExp(`^environments/demo/locks/${missingPlatform}\\.txt: lock file .* is required`)
  ])

  const malformed = pluginFixture()
  const malformedPlatform = PHI_PLATFORMS[1]
  write(
    join(malformed, 'environments', 'demo', 'locks', `${malformedPlatform}.txt`),
    'not-explicit\n'
  )
  assertInvalid(malformed, [
    new RegExp(
      `^environments/demo/locks/${malformedPlatform}\\.txt: line 1: explicit lock must start with @EXPLICIT`
    )
  ])
})

test('agents and skills are validated using their own contracts', () => {
  const invalidAgent = pluginFixture(undefined, {
    'agents/Demo.md': agentDocument({ extra: 'visibility: internal\n' })
  })
  assertInvalid(invalidAgent, [/^agents\/Demo\.md:visibility: visibility 'internal' is reserved/])

  const invalidSkill = pluginFixture(undefined, {
    'skills/demo-skill/SKILL.md': skillDocument({ extraPhi: '  toolPrefix: nested\n' })
  })
  assertInvalid(invalidSkill, [
    /^skills\/demo-skill:phi\.toolPrefix: toolPrefix is rejected inside a plugin/
  ])
})

test('plugin environment references are private to the declaring plugin', () => {
  const agentRef = pluginFixture(undefined, {
    'agents/Demo.md': agentDocument({ environment: 'plugin:other' })
  })
  assertInvalid(agentRef, [
    /^agents\/Demo\.md:environment: plugin environment 'other' is not declared by plugin 'demo-plugin'/
  ])

  const skillRef = pluginFixture(undefined, {
    'skills/demo-skill/SKILL.md': skillDocument({ environment: 'plugin:other' })
  })
  assertInvalid(skillRef, [
    /^skills\/demo-skill:phi\.environment: plugin environment 'other' is not declared by plugin 'demo-plugin'/
  ])
})

test('non-plugin environment references remain valid inside plugin components', () => {
  const dir = pluginFixture(undefined, {
    'agents/Demo.md': agentDocument({ environment: 'phi:python@1' }),
    'skills/demo-skill/SKILL.md': skillDocument({ environment: 'project:custom' })
  })
  assertValid(dir)
})

test('attachTo accepts main and this plugin agents, but rejects outside agents', () => {
  assertValid(pluginFixture())

  const main = pluginFixture(undefined, {
    'skills/demo-skill/SKILL.md': skillDocument({ attachTo: '[main]' })
  })
  assertValid(main)

  const outside = pluginFixture(undefined, {
    'skills/demo-skill/SKILL.md': skillDocument({ attachTo: '[Other]' })
  })
  assertInvalid(outside, [
    /^skills\/demo-skill:phi\.attachTo\[0\]: attachTo target 'Other' must be main or an agent in this plugin/
  ])
})

test('engine-reserved plugin tool prefixes are rejected', () => {
  for (const prefix of ['skill', 'env', 'http', 'wrapper', 'agent', 'db', 'mcp']) {
    const dir = pluginFixture((manifest) => {
      manifest.toolPrefix = prefix
    })
    assertInvalid(dir, [new RegExp(`^toolPrefix: toolPrefix '${prefix}' is reserved`)])
  }
})

test('component warnings are retained with their component path', () => {
  const dir = pluginFixture(undefined, {
    'agents/Demo.md': agentDocument({ extra: 'vendorHint: true\n' })
  })
  const result = validatePlugin(dir)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [
    {
      level: 'warning',
      path: 'agents/Demo.md:vendorHint',
      message: "unknown key 'vendorHint'"
    }
  ])
  assert.ok(result.plugin)
})

test('the bundled Visualization plugin validates without errors', () => {
  const result = validatePlugin(join(REPO_ROOT, 'resources', 'plugins', 'visualization'))
  assert.equal(result.ok, true, texts(result.errors).join('\n'))
  assert.deepEqual(result.errors, [])
  assert.ok(result.plugin)
  assert.equal(result.plugin.manifest.id, 'visualization')
})

test('the published schema remains parseable YAML-compatible JSON', () => {
  const text = readFileSync(join(REPO_ROOT, 'docs', 'contracts', 'plugin.schema.json'), 'utf8')
  assert.deepEqual(parseYaml(text), pluginManifestSchema)
})
