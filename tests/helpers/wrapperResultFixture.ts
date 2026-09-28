import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Project } from '../../src/main/agent/projects'
import type { WrapperResultDependencies } from '../../src/main/agent/wrappers/remote-results'
import type { RemoteSshSession } from '../../src/main/agent/wrappers/remote-ssh-session'
import type { WrapperRun } from '../../src/main/agent/wrappers/types'
import type { WrapperResultDirectoryRequest } from '../../src/shared/wrapperResultTypes'

export function wrapperResultFixture(): {
  workspace: string
  runRoot: string
  outputRoot: string
  outside: string
  run: WrapperRun
  project: Project
  dependencies: WrapperResultDependencies
  connections: () => number
  closed: () => number
  commands: string[]
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-wrapper-results-'))
  mkdirSync(join(base, 'workspace'))
  const workspace = realpathSync(join(base, 'workspace'))
  const runRoot = join(workspace, 'wrappers', 'runs', 'wrun_a')
  const outputRoot = join(runRoot, 'results')
  mkdirSync(join(base, 'outside'))
  const outside = realpathSync(join(base, 'outside'))
  mkdirSync(outputRoot, { recursive: true })
  writeFileSync(join(outputRoot, 'report.html'), '<html>ok</html>')
  writeFileSync(join(outside, 'private.txt'), 'outside')
  const run = {
    runId: 'wrun_a',
    state: 'running',
    outDir: outputRoot,
    remote: {
      host: 'cluster-a',
      hostProfileId: 'host-a',
      projectId: 'project-a',
      workspaceRoot: workspace,
      runDir: runRoot,
      outputRoot
    }
  } as WrapperRun
  const project = {
    id: 'project-a',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-a',
      remoteRoot: workspace,
      canonicalRoot: workspace
    }
  } as Project
  let connectionCount = 0
  let closeCount = 0
  const commands: string[] = []
  const execute = (command: string): Awaited<ReturnType<RemoteSshSession['exec']>> => {
    commands.push(command)
    const result = spawnSync('bash', ['-c', command], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 2_000_000
    })
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code: result.status,
      signal: result.signal
    }
  }
  const session: RemoteSshSession = {
    exec: async (command) => execute(command),
    execBounded: async (command, options) => {
      options.signal?.throwIfAborted()
      const result = execute(command)
      options.signal?.throwIfAborted()
      return {
        ...result,
        stdoutTruncated: Buffer.byteLength(result.stdout, 'utf8') > options.maxOutputBytes,
        stderrTruncated: Buffer.byteLength(result.stderr, 'utf8') > options.maxOutputBytes
      }
    },
    readTextFile: async () => {
      throw new Error('unbounded read not allowed')
    },
    writeTextFile: async () => {
      throw new Error('write not allowed')
    },
    mkdirp: async () => {
      throw new Error('mkdir not allowed')
    },
    exists: async () => {
      throw new Error('exists not used')
    },
    close: async () => {
      closeCount += 1
    }
  }
  const dependencies: WrapperResultDependencies = {
    agentDir: join(base, 'agent'),
    getRun: (id) => (id === run.runId ? run : undefined),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a'
        ? { id, label: 'Cluster A', hostAlias: 'cluster-a' }
        : id === 'host-b'
          ? { id, label: 'Cluster B', hostAlias: 'cluster-b' }
          : undefined,
    connectImpl: async () => {
      connectionCount += 1
      return session
    }
  }
  return {
    workspace,
    runRoot,
    outputRoot,
    outside,
    run,
    project,
    dependencies,
    connections: () => connectionCount,
    closed: () => closeCount,
    commands,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

export function wrapperResultRequest(
  scope: WrapperResultDirectoryRequest['scope'],
  path = ''
): WrapperResultDirectoryRequest {
  return {
    projectId: 'project-a',
    hostProfileId: 'host-a',
    runId: 'wrun_a',
    scope,
    path
  }
}
