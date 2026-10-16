import assert from 'node:assert/strict'
import { exec as execCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  detectNearestOmpAgentDefinitions,
  renameDetectedOmpAgent
} from '../src/main/agent/engine/rpc/subagents/agent-conflict-remote'
import {
  nextProjectAgentName,
  nextRpcAgentAlias,
  planRpcPublishedAgentNames
} from '../src/main/agent/engine/rpc/subagents/published-agent-names'
import { AgentNameConflictCoordinator } from '../src/main/agent/agent-name-conflict-coordinator'
import type { Project } from '../src/main/agent/projects'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import { compileOptions, definition } from './helpers/rpcAgentDefinitionFixture'

const exec = promisify(execCallback)

function shellSession(): RemoteSshSession {
  const run = async (
    command: string
  ): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> => {
    try {
      const result = await exec(command, {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000
      })
      return { stdout: result.stdout, stderr: result.stderr, code: 0, signal: null }
    } catch (error) {
      const value = error as Error & {
        stdout?: string
        stderr?: string
        code?: number
        signal?: string
      }
      return {
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? '',
        code: typeof value.code === 'number' ? value.code : null,
        signal: value.signal ?? null
      }
    }
  }
  return {
    exec: run,
    execBounded: async (command) => ({
      ...(await run(command)),
      stdoutTruncated: false,
      stderrTruncated: false
    }),
    readTextFile: async () => '',
    writeTextFile: async () => undefined,
    mkdirp: async () => undefined,
    exists: async () => false,
    uploadFile: async () => undefined,
    close: async () => undefined
  }
}

function markdown(name: string, marker = 'ORIGINAL_BODY'): string {
  return `---\nname: ${name}\ndescription: Project agent\ntools: [read]\n---\n${marker}\n`
}

test('production publication names are stable before model selection and aliases stay exact', () => {
  const options = compileOptions({ definitions: [definition(), definition({ name: 'Review' })] })
  const first = planRpcPublishedAgentNames(options.definitions, options.binding)
  const second = planRpcPublishedAgentNames(structuredClone(options.definitions), options.binding)
  assert.deepEqual(
    first.map(({ defaultName }) => defaultName),
    second.map(({ defaultName }) => defaultName)
  )
  const foreground = first.find((entry) => entry.sourceName === 'Research' && entry.blocking)!
  const alias = nextRpcAgentAlias(
    foreground.sourceName,
    new Set(first.map((entry) => entry.nativeName))
  )
  const aliased = planRpcPublishedAgentNames(options.definitions, options.binding, {
    [foreground.sourceName]: alias
  })
  assert.equal(
    aliased.find((entry) => entry.defaultName === foreground.defaultName)?.nativeName,
    alias
  )
  assert.deepEqual(
    aliased
      .filter((entry) => entry.sourceName === foreground.sourceName)
      .map((entry) => [entry.displayName, entry.nativeName]),
    [
      [alias, alias],
      [alias, `${alias}-background`]
    ]
  )
  assert.equal(
    nextProjectAgentName(foreground.defaultName, new Set()),
    `${foreground.defaultName}-project`
  )
  assert.equal(
    nextRpcAgentAlias(foreground.sourceName, new Set([`${foreground.sourceName}-phi`])),
    `${foreground.sourceName}-phi-2`
  )
  assert.equal(
    nextRpcAgentAlias(foreground.sourceName, new Set([`${foreground.sourceName}-phi-background`])),
    `${foreground.sourceName}-phi-2`
  )
  assert.equal(
    nextProjectAgentName(foreground.defaultName, new Set([`${foreground.defaultName}-project`])),
    `${foreground.defaultName}-project-2`
  )
})

test('nearest ancestor conflict can be atomically renamed outside the project with metadata preserved', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-agent-conflict-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'parent/project/nested')
  const agents = join(root, 'parent/.omp/agents')
  await mkdir(project, { recursive: true })
  await mkdir(agents, { recursive: true })
  const path = join(agents, 'shadow.md')
  const oldName = 'phi_0123456789abcdef01234567_0_fg'
  const nextName = `${oldName}-project`
  const before = markdown(oldName)
  await writeFile(path, before, { mode: 0o640 })
  await chmod(path, 0o640)
  const session = shellSession()
  const detections = await detectNearestOmpAgentDefinitions(session, project, [])
  assert.equal(detections.length, 1)
  assert.equal(detections[0].filePath, path)
  await assert.rejects(
    renameDetectedOmpAgent(
      session,
      { ...detections[0], pathIdentity: [...detections[0].pathIdentity] },
      nextName
    ),
    /not issued by conflict detection/u
  )
  const beforeStat = await lstat(path)
  await renameDetectedOmpAgent(session, detections[0], nextName)
  const after = await readFile(path, 'utf8')
  const afterStat = await lstat(path)
  assert.equal(after, before.replace(`name: ${oldName}`, `name: ${nextName}`))
  assert.equal(afterStat.mode & 0o777, beforeStat.mode & 0o777)
  assert.equal(afterStat.uid, beforeStat.uid)
  assert.equal(afterStat.gid, beforeStat.gid)
  assert.equal(
    (await readdir(agents)).some((name) => name.startsWith('.phi-agent-rename-')),
    false
  )
})

test('rename refuses a content hash mismatch', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-agent-conflict-hash-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const agents = join(project, '.omp/agents')
  await mkdir(agents, { recursive: true })
  const path = join(agents, 'shadow.md')
  await writeFile(path, markdown('Shadow'))
  const session = shellSession()
  const [detection] = await detectNearestOmpAgentDefinitions(session, project, [])
  await writeFile(path, markdown('Shadow', 'CHANGED'))
  await assert.rejects(
    renameDetectedOmpAgent(session, detection, 'Shadow-project'),
    /content changed since detection/
  )
})

test('detector follows OMP YAML semantics for block scalar names and ignores invalid agents', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-agent-conflict-yaml-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const agents = join(project, '.omp/agents')
  await mkdir(agents, { recursive: true })
  await writeFile(join(agents, 'invalid.md'), '---\nname: BlockAgent\n---\nINVALID\n')
  const path = join(agents, 'valid.md')
  await writeFile(
    path,
    '---\nname: >-\n  BlockAgent\ndescription: Valid block scalar\ntools: [read]\n---\nBODY\n'
  )
  const session = shellSession()
  const detections = await detectNearestOmpAgentDefinitions(session, project, ['BlockAgent'])
  assert.equal(detections.length, 1)
  assert.equal(detections[0].filePath, path)
  await renameDetectedOmpAgent(session, detections[0], 'BlockAgent-project')
  const updated = await readFile(path, 'utf8')
  assert.match(updated, /name: BlockAgent-project/u)
  assert.match(updated, /description: Valid block scalar/u)
  assert.match(updated, /---\nBODY\n$/u)
})

test('rename refuses symlink files and symlink directory components', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-agent-conflict-link-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = shellSession()

  const fileProject = join(root, 'file-project')
  const fileAgents = join(fileProject, '.omp/agents')
  await mkdir(fileAgents, { recursive: true })
  const target = join(root, 'target.md')
  await writeFile(target, markdown('Linked'))
  await symlink(target, join(fileAgents, 'linked.md'))
  const [fileDetection] = await detectNearestOmpAgentDefinitions(session, fileProject, [])
  await assert.rejects(
    renameDetectedOmpAgent(session, fileDetection, 'Linked-project'),
    /symbolic link/
  )

  const directoryProject = join(root, 'directory-project')
  const realOmp = join(root, 'real-omp')
  await mkdir(join(realOmp, 'agents'), { recursive: true })
  await mkdir(directoryProject, { recursive: true })
  await writeFile(join(realOmp, 'agents/shadow.md'), markdown('DirectoryLinked'))
  await symlink(realOmp, join(directoryProject, '.omp'))
  const [directoryDetection] = await detectNearestOmpAgentDefinitions(session, directoryProject, [])
  await assert.rejects(
    renameDetectedOmpAgent(session, directoryDetection, 'DirectoryLinked-project'),
    /symbolic link/
  )
})

test('coordinator queues startup conflicts, persists each decision at its approved scope, and rejects unconfirmed IDs', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-agent-conflict-coordinator-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, 'project')
  const agents = join(projectRoot, '.omp/agents')
  await mkdir(agents, { recursive: true })
  const cacheKey = JSON.stringify(['host-1', projectRoot, projectRoot, 'fixture'])
  const binding = {
    serverId: 'host-1',
    serverIdentitySha256: createHash('sha256').update(cacheKey).digest('hex'),
    projectId: 'project-1',
    projectRoot
  }
  const definitions = [definition({ model: undefined })]
  const foreground = planRpcPublishedAgentNames(definitions, binding).find(
    (entry) => entry.blocking
  )!
  const path = join(agents, 'shadow.md')
  await writeFile(path, markdown(foreground.nativeName))
  let project: Project = {
    id: 'project-1',
    name: 'Project',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: projectRoot,
      canonicalRoot: projectRoot
    },
    workingDirectory: projectRoot,
    workingDirectoryRealPath: projectRoot,
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: new Date().toISOString()
  }
  let manifest: PhiSessionManifest = {
    schemaVersion: 1,
    sessionId: 'session-1',
    kind: 'project',
    projectId: project.id,
    projectLocation: project.location,
    cwd: projectRoot,
    cwdRealPath: projectRoot,
    permissionMode: 'ask',
    status: 'idle',
    unreadKind: null,
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  }
  const audits: unknown[] = []
  const connection = {
    sessionId: manifest.sessionId,
    projectId: project.id,
    hostAlias: 'fixture-host',
    remoteRoot: projectRoot,
    canonicalRoot: projectRoot,
    cacheKey,
    config: {
      remoteRoot: projectRoot,
      canonicalRoot: projectRoot,
      connect: async () => shellSession()
    }
  }
  const coordinator = new AgentNameConflictCoordinator({
    resolveBinding: () => connection,
    getProject: () => project,
    getSession: () => manifest,
    updateAliases: (_id, aliases) => {
      project = { ...project, rpcAgentAliases: { ...aliases } }
      return project
    },
    updateSession: (_id, patch) => {
      manifest = { ...manifest, ...patch }
      return manifest
    },
    audit: (entry) => {
      audits.push(entry)
    }
  })
  const first = await coordinator.inspect({
    sessionId: manifest.sessionId,
    projectId: project.id,
    definitions,
    enqueueDialogs: true
  })
  assert.equal(first.conflicts.length, 1)
  assert.equal(coordinator.pending()?.id, first.conflicts[0].id)
  await assert.rejects(
    coordinator.resolve('not-a-detected-conflict', 'rename_phi'),
    /no longer current/
  )
  await coordinator.resolve(first.conflicts[0].id, 'rename_phi')
  assert.equal(project.rpcAgentAliases?.[foreground.sourceName], first.conflicts[0].proposedPhiName)
  assert.equal(
    (
      await coordinator.inspect({
        sessionId: manifest.sessionId,
        projectId: project.id,
        definitions,
        enqueueDialogs: false
      })
    ).conflicts.length,
    0
  )

  project = { ...project, rpcAgentAliases: undefined }
  const second = await coordinator.inspect({
    sessionId: manifest.sessionId,
    projectId: project.id,
    definitions,
    enqueueDialogs: false
  })
  await coordinator.resolve(second.conflicts[0].id, 'not_now')
  const deferred = await coordinator.inspect({
    sessionId: manifest.sessionId,
    projectId: project.id,
    definitions,
    enqueueDialogs: false
  })
  assert.equal(deferred.conflicts.length, 0)
  assert.equal(Object.keys(deferred.blockedAgents).length, 2)
  assert.match(deferred.blockedAgents[foreground.nativeName].filePath, /shadow\.md$/u)

  await rm(path)
  const replacementPath = join(agents, 'replacement.md')
  const replacement = markdown(foreground.nativeName, 'REPLACEMENT_BODY')
  await writeFile(replacementPath, replacement)
  const refreshedDeferral = await coordinator.inspect({
    sessionId: manifest.sessionId,
    projectId: project.id,
    definitions,
    enqueueDialogs: false
  })
  assert.equal(refreshedDeferral.conflicts.length, 0)
  assert.equal(refreshedDeferral.blockedAgents[foreground.nativeName].filePath, replacementPath)
  assert.equal(
    refreshedDeferral.blockedAgents[foreground.nativeName].contentHash,
    createHash('sha256').update(replacement).digest('hex')
  )

  manifest = { ...manifest, rpcAgentConflictDeferrals: undefined }
  const renameOther = await coordinator.inspect({
    sessionId: manifest.sessionId,
    projectId: project.id,
    definitions,
    enqueueDialogs: false
  })
  await coordinator.resolve(renameOther.conflicts[0].id, 'rename_other')
  assert.match(await readFile(replacementPath, 'utf8'), /-project/u)
  assert.equal(audits.length, 1)
})

test('a later inline inspection suppresses an overlapping startup dialog publication', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-agent-conflict-race-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, 'project')
  const agents = join(projectRoot, '.omp/agents')
  await mkdir(agents, { recursive: true })
  const cacheKey = JSON.stringify(['host-1', projectRoot, projectRoot, 'fixture'])
  const binding = {
    serverId: 'host-1',
    serverIdentitySha256: createHash('sha256').update(cacheKey).digest('hex'),
    projectId: 'project-1',
    projectRoot
  }
  const definitions = [definition({ model: undefined })]
  const nativeName = planRpcPublishedAgentNames(definitions, binding).find(
    (entry) => entry.blocking
  )!.nativeName
  await writeFile(join(agents, 'shadow.md'), markdown(nativeName))
  const project = {
    id: 'project-1',
    name: 'Project',
    location: {
      kind: 'ssh' as const,
      hostProfileId: 'host-1',
      remoteRoot: projectRoot,
      canonicalRoot: projectRoot
    },
    workingDirectory: projectRoot,
    workingDirectoryRealPath: projectRoot,
    permissionMode: 'ask' as const,
    pathAvailable: true,
    createdAt: new Date().toISOString()
  }
  const manifest = {
    schemaVersion: 1 as const,
    sessionId: 'session-1',
    kind: 'project' as const,
    projectId: project.id,
    projectLocation: project.location,
    cwd: projectRoot,
    cwdRealPath: projectRoot,
    permissionMode: 'ask' as const,
    status: 'idle' as const,
    unreadKind: null,
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  }
  let releaseFirst!: () => void
  let markFirstStarted!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve
  })
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let connections = 0
  const connection = {
    sessionId: manifest.sessionId,
    projectId: project.id,
    hostAlias: 'fixture-host',
    remoteRoot: projectRoot,
    canonicalRoot: projectRoot,
    cacheKey,
    config: {
      remoteRoot: projectRoot,
      canonicalRoot: projectRoot,
      connect: async (): Promise<RemoteSshSession> => {
        const base = shellSession()
        if (connections++ > 0) return base
        return {
          ...base,
          execBounded: async (command, options) => {
            markFirstStarted()
            await firstGate
            return base.execBounded!(command, options)
          }
        }
      }
    }
  }
  const coordinator = new AgentNameConflictCoordinator({
    resolveBinding: () => connection,
    getProject: () => project,
    getSession: () => manifest,
    audit: () => undefined
  })
  const startup = coordinator.inspect({
    sessionId: manifest.sessionId,
    projectId: project.id,
    definitions,
    enqueueDialogs: true
  })
  await firstStarted
  const endInline = coordinator.beginInlineResolution(manifest.sessionId)
  const inline = await coordinator.inspect({
    sessionId: manifest.sessionId,
    projectId: project.id,
    definitions,
    enqueueDialogs: false
  })
  assert.equal(inline.conflicts.length, 1)
  releaseFirst()
  await startup
  assert.equal(coordinator.pending(), null)
  endInline()
  await coordinator.inspect({
    sessionId: manifest.sessionId,
    projectId: project.id,
    definitions,
    enqueueDialogs: true
  })
  assert.equal(coordinator.pending()?.sessionId, manifest.sessionId)
  const dismissVisibleDialog = coordinator.beginInlineResolution(manifest.sessionId)
  assert.equal(coordinator.pending(), null)
  dismissVisibleDialog()
})
