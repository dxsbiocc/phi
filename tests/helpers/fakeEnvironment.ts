import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import Ajv from 'ajv'

import type { EnvironmentDescriptor } from '../../src/main/agent/content'
import type { ValidatedSkill } from '../../src/main/agent/content/skill'
import { computeEnvId, envMetadataSchema, lockSha256 } from '../../src/main/agent/envs'

const MINIMAL = join(process.cwd(), 'tests/fixtures/envs/minimal')
const validateMetadata = new Ajv({ allErrors: true, strict: false }).compile(envMetadataSchema)

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function copyMinimal(dir: string, name?: string): void {
  mkdirSync(dir, { recursive: true })
  const spec = readFileSync(join(MINIMAL, 'environment.yml'), 'utf8')
  const text = name === undefined ? spec : spec.replace(/^name:\s*\S+/m, `name: ${name}`)
  writeFileSync(join(dir, 'environment.yml'), text)
  cpSync(join(MINIMAL, 'locks'), join(dir, 'locks'), { recursive: true })
}

export function skillStub(dir: string, name: string, environment?: string): ValidatedSkill {
  const description = 'Echo script arguments as JSON.'
  const skill: ValidatedSkill = {
    dir,
    name,
    description,
    body: '',
    frontmatter: { name, description }
  }
  if (environment) {
    skill.phi = { environment }
    skill.frontmatter.phi = { environment }
  }
  return skill
}

export function envIdFor(descriptor: EnvironmentDescriptor): string {
  return computeEnvId({
    scope: descriptor.scope,
    owner: descriptor.owner,
    name: descriptor.spec.name,
    platform: descriptor.platform,
    lockText: descriptor.lockText,
    sourcePackages: descriptor.spec.sourcePackages
  })
}

export function writeExecutable(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const script = body.startsWith('#!') ? body : `#!/bin/sh\n${body}`
  writeFileSync(file, script.endsWith('\n') ? script : `${script}\n`, { mode: 0o755 })
  chmodSync(file, 0o755)
}

/** A ready environment with stand-in binaries. Nothing is solved or downloaded. */
export function installReady(
  root: string,
  descriptor: EnvironmentDescriptor,
  binaries: Record<string, string>
): string {
  const envId = envIdFor(descriptor)
  const prefix = join(root, 'envs', envId)
  const bin = join(prefix, 'bin')
  mkdirSync(bin, { recursive: true })
  const metadata = {
    envId,
    name: descriptor.spec.name,
    kind: descriptor.kind,
    platform: descriptor.platform,
    lockSha256: lockSha256(descriptor.lockText),
    createdAt: '2026-09-29T00:00:00.000Z',
    micromambaVersion: '2.9.0',
    activation: { set: {}, pathPrepend: [join(prefix, 'bin')] },
    host: {},
    sourcePackages: descriptor.spec.sourcePackages ?? [],
    status: 'ready' as const,
    contractVersion: '1.1.0'
  }
  assert.equal(validateMetadata(metadata), true, JSON.stringify(validateMetadata.errors))
  mkdirSync(join(prefix, '.phi'), { recursive: true })
  writeFileSync(join(prefix, '.phi', 'env.json'), `${JSON.stringify(metadata)}\n`)
  for (const [name, body] of Object.entries(binaries)) writeExecutable(join(bin, name), body)
  return envId
}

export function argvShell(nodePath: string, printer: string, marker: string): string {
  return `#!/bin/sh
echo ran > ${shQuote(marker)}
exec ${shQuote(nodePath)} ${shQuote(printer)} "$@"
`
}

export function shell(lines: string[]): string {
  return `#!/bin/sh\n${lines.join('\n')}\n`
}
