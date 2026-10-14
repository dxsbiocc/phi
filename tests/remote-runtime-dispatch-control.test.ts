import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RemoteRuntimeController } from '../src/main/agent/remote-runtime/controller'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import { createRemoteRuntimeInputExec } from '../src/main/agent/remote-runtime/input-exec'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations,
  writeTestSkill
} from './helpers/remoteRuntimeFixture'

for (const boundary of ['workspace', 'launch', 'stdin'] as const)
  for (const failure of ['stop', 'rebind'] as const)
    test(`remote skill ${failure} during ${boundary} preparation never submits the tool`, async () => {
      const f = createRemoteRuntimeFixture()
      installFakeMicromamba(f)
      const source = writeTestSkill(f)
      let hold = false,
        reached!: () => void,
        release!: () => void
      const ready = new Promise<void>((resolve) => {
        reached = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const pause = async (): Promise<void> => {
        if (hold) {
          reached()
          await gate
        }
      }
      const host = new SshHost({
        remoteRoot: f.projectRoot,
        canonicalRoot: f.projectRoot,
        connect: async () => {
          const session = await f.connect()
          const write = session.writeTextFile.bind(session)
          const open = session.openStdio!.bind(session)
          return {
            ...session,
            writeTextFile: async (path, value) => {
              await write(path, value)
              if (boundary === 'launch' && path.endsWith('/launch.sh')) await pause()
            },
            openStdio: async (command) => {
              const process = await open(command)
              if (boundary === 'stdin') await pause()
              return process
            }
          }
        }
      })
      const input = createRemoteRuntimeInputExec(async () => {
        const session = await f.connect()
        const open = session.openStdio!.bind(session)
        return {
          ...session,
          openStdio: async (command) => {
            const process = await open(command)
            if (boundary === 'stdin') await pause()
            return process
          }
        }
      })
      const runtime = new RemoteRuntimeController({
        micromambaVersion: 'test',
        resolveTarget: () => ({
          runtimeSessionId: 'runtime',
          sessionId: 'phi',
          projectId: 'project',
          configuredRoot: f.runtimeRoot
        }),
        listSkills: async () => [{ ...source, insidePlugin: false }],
        confirmEnvironment: async () => true,
        resolveBasePackages: async () => ['bash'],
        openWorkspace: async () => {
          if (boundary === 'workspace') await pause()
          return { ...f.workspace, projectHost: host, execWithInput: input }
        }
      })
      const identity = { runtimeSessionId: 'runtime', remoteSessionId: 'phi', projectId: 'project' }
      try {
        const environment = await runtime.requestEnvironment({
          ...identity,
          requestId: 'seed',
          environment: 'phi:python@1',
          packages: ['coreutils'],
          reason: 'tiny isolated fixture'
        })
        assert.ok('envId' in environment)
        await runtime.scriptTools(identity)
        const before = readFakeMicromambaInvocations(f)
        const controller = new AbortController()
        let bound = true
        hold = true
        const call = runtime.runScriptTool(
          {
            ...identity,
            requestId: 'target',
            tool: 'remotedemo_json',
            args: { message: 'must-not-run' }
          },
          {
            signal: controller.signal,
            beforeDispatch: () => {
              assert.ok(bound, 'runtime binding changed')
            }
          }
        )
        await ready
        if (failure === 'stop') controller.abort(new Error('target stopped'))
        else bound = false
        release()
        const result = await call
        assert.equal(result.ok, false)
        assert.deepEqual(
          readFakeMicromambaInvocations(f),
          before,
          'no accepted command after the held preparation'
        )
        assert.match(readFileSync(join(source.dir, 'scripts/json.sh'), 'utf8'), /message/)
      } finally {
        release?.()
        await host.close()
        await Promise.all(f.sessions.map((session) => session.close()))
        f.cleanup()
      }
    })
