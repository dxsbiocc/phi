import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { stringify as stringifyYaml } from 'yaml'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  installPackages,
  planInstall,
  readRegistry,
  type RegistryPackageEntry
} from '../src/main/agent/packages/installer'
import type { PullTeamReleaseResult } from '../src/main/agent/team-pack/pull'

export const TEAM_ID = 'alpha-team'
export const SKILL_ID = 'shared-analysis'

export function writeSkillRegistry(registryDir: string, version: string): void {
  mkdirSync(registryDir, { recursive: true })
  const skill = Buffer.from(
    `---\nname: ${SKILL_ID}\ndescription: Shared team skill.\nmetadata:\n  version: ${version}\n---\n# Shared ${version}\n`
  )
  const manifest = Buffer.from(
    stringifyYaml({
      schemaVersion: 1,
      id: SKILL_ID,
      type: 'skill',
      version,
      title: 'Shared analysis',
      summary: 'Shared team skill fixture.',
      files: 'files.json'
    })
  )
  const listed = [fileRecord('SKILL.md', skill), fileRecord('phi-package.yaml', manifest)]
  const filesJson = Buffer.from(`${JSON.stringify({ version: 1, files: listed }, null, 2)}\n`)
  const archive = createDeterministicTarGz([
    { path: 'SKILL.md', data: skill },
    { path: 'files.json', data: filesJson },
    { path: 'phi-package.yaml', data: manifest }
  ])
  const archiveName = `skill-${SKILL_ID}-${version}.tar.gz`
  writeFileSync(join(registryDir, archiveName), archive)
  const entry: RegistryPackageEntry = {
    id: SKILL_ID,
    type: 'skill',
    version,
    title: 'Shared analysis',
    summary: 'Shared team skill fixture.',
    archive: archiveName,
    sha256: digest(archive),
    size: archive.length,
    dependsOn: []
  }
  writeFileSync(
    join(registryDir, 'index.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '2026-10-24T00:00:00.000Z',
        packages: [entry]
      },
      null,
      2
    )}\n`
  )
  readRegistry(registryDir)
}

export async function installPulledSkill(
  pull: PullTeamReleaseResult,
  agentDir: string
): Promise<void> {
  const registry = readRegistry(pull.registryDir)
  await installPackages(planInstall(registry, { type: 'skill', id: SKILL_ID }, { agentDir }), {
    agentDir
  })
}

export function installedSkillPath(agentDir: string, version: string): string {
  return join(agentDir, 'packages', 'skill', SKILL_ID, version, 'SKILL.md')
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

export function digest(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function fileRecord(path: string, data: Buffer): { path: string; size: number; sha256: string } {
  return { path, size: data.length, sha256: digest(data) }
}
