import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stringify as stringifyYaml } from 'yaml'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  installPackages,
  planInstall,
  readRegistry,
  type RegistryPackageEntry
} from '../src/main/agent/packages/installer'
import {
  createMemberKeys,
  createTeamKeys,
  DirectoryTeamPackStore,
  publishTeamRelease,
  pullTeamRelease,
  TeamPackError,
  writeMemberKeys,
  writeTeamKeys,
  type PullTeamReleaseResult
} from '../src/main/agent/team-pack'

const TEAM_ID = 'demo-team'
const SKILL_ID = 'shared-analysis'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-team-pack-demo-'))
  try {
    const registryDir = join(root, 'registry')
    const storeDir = join(root, 'store')
    const privateDir = join(root, 'private-keys')
    const team = createTeamKeys({ teamId: TEAM_ID, name: 'Phi Demo Team' })
    const members = await Promise.all([createMemberKeys(), createMemberKeys(), createMemberKeys()])
    mkdirSync(privateDir, { recursive: true })
    writeTeamKeys(join(privateDir, 'team.json'), team)
    for (const [index, member] of members.entries()) {
      writeMemberKeys(join(privateDir, `member-${index + 1}.json`), member)
    }
    console.log(`1. 已创建团队 ${team.teamId}（指纹 ${team.keyId}）和 3 名成员`)

    writeDemoRegistry(registryDir, '1.0.0')
    await publishTeamRelease({
      storeDir,
      team,
      members: members.map((member) => member.recipient),
      registryDir,
      createdAt: '2026-10-24T01:00:00.000Z'
    })
    console.log('2. 已发布 v1（一份密文，3 名接收方）')

    const store = new DirectoryTeamPackStore(storeDir)
    for (const [index, member] of members.entries()) {
      const pull = await pullTeamRelease({
        store,
        teamKeyId: team.keyId,
        identity: member.identity,
        stateDir: join(root, `state-${index + 1}`)
      })
      await install(pull, join(root, `agent-${index + 1}`))
      assert.match(
        readFileSync(
          join(root, `agent-${index + 1}`, 'packages/skill', SKILL_ID, '1.0.0/SKILL.md'),
          'utf8'
        ),
        /Demo 1\.0\.0/
      )
      console.log(`3.${index + 1} 成员 ${index + 1} 已拉取并真实安装 v1 资源`)
    }

    writeDemoRegistry(registryDir, '2.0.0')
    await publishTeamRelease({
      storeDir,
      team,
      members: members.slice(0, 2).map((member) => member.recipient),
      registryDir,
      createdAt: '2026-10-24T02:00:00.000Z'
    })
    console.log('4. 已移除成员 3 并发布 v2（接收方仅成员 1、2）')

    for (let index = 0; index < members.length; index++) {
      try {
        const pull = await pullTeamRelease({
          store,
          teamKeyId: team.keyId,
          identity: members[index].identity,
          stateDir: join(root, `state-${index + 1}`)
        })
        if (index === 2) throw new Error('被移除成员意外解密了 v2')
        assert.equal(pull.release, 2)
        console.log(`5.${index + 1} 成员 ${index + 1} 已拉取 v2`)
      } catch (error) {
        if (index !== 2 || !(error instanceof TeamPackError) || error.code !== 'NOT_A_MEMBER') {
          throw error
        }
        const oldSkill = join(
          root,
          `agent-${index + 1}`,
          'packages/skill',
          SKILL_ID,
          '1.0.0/SKILL.md'
        )
        assert.match(readFileSync(oldSkill, 'utf8'), /Demo 1\.0\.0/)
        console.log('5.3 成员 3 得到 NOT_A_MEMBER；已安装的 v1 仍可读取')
      }
    }
    console.log('6. 团队包 L0 演示全部符合预期')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function install(pull: PullTeamReleaseResult, agentDir: string): Promise<void> {
  const registry = readRegistry(pull.registryDir)
  await installPackages(planInstall(registry, { type: 'skill', id: SKILL_ID }, { agentDir }), {
    agentDir
  })
}

function writeDemoRegistry(registryDir: string, version: string): void {
  mkdirSync(registryDir, { recursive: true })
  const skill = Buffer.from(
    `---\nname: ${SKILL_ID}\ndescription: Demo team skill.\nmetadata:\n  version: ${version}\n---\n# Demo ${version}\n`
  )
  const manifest = Buffer.from(
    stringifyYaml({
      schemaVersion: 1,
      id: SKILL_ID,
      type: 'skill',
      version,
      title: 'Shared analysis',
      summary: 'Team-pack demo skill.',
      files: 'files.json'
    })
  )
  const listed = [record('SKILL.md', skill), record('phi-package.yaml', manifest)]
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
    summary: 'Team-pack demo skill.',
    archive: archiveName,
    sha256: sha256(archive),
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

function record(path: string, data: Buffer): { path: string; size: number; sha256: string } {
  return { path, size: data.length, sha256: sha256(data) }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '团队包演示失败')
  process.exitCode = 1
})
