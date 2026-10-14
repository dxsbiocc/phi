import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import type {
  AppRemoteDesktopResources,
  AppRemoteSessionRoutingOptions
} from '../../src/main/agent/remote-session-routing'
import { RemoteRuntimeController } from '../../src/main/agent/remote-runtime/controller'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import { createRemoteRuntimeInputExec } from '../../src/main/agent/remote-runtime/input-exec'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import {
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import type { PhiHostRequestContext } from '../../src/main/agent/engine/types'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations,
  writeTestSkill
} from './remoteRuntimeFixture'

type Identity = Parameters<NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>>[0]
export function createApplicationSkillHarness(
  f: FacadeMetadataFixture,
  mode: string
): {
  resources(identity: Identity, signal: AbortSignal): Promise<AppRemoteDesktopResources>
  run(): Promise<void>
  close(): Promise<void>
} {
  const server = createRemoteRuntimeFixture()
  const root = f.f.scope.projectRoot
  const environmentFixture = { ...server, projectRoot: root, runtimeRoot: f.f.runtimeRoot }
  const binary = installFakeMicromamba(environmentFixture)
  // The invocation reader intentionally expects its real ledger, even before the first command.
  const ledgerReady = writeFile(join(f.f.runtimeRoot, 'micromamba-invocations.log'), '')
  const source = writeTestSkill(server)
  const identities = new Map<string, Identity>()
  const host = new SshHost({
    remoteRoot: root,
    canonicalRoot: root,
    connect: async () => ({ ...f.f.session, ...f.hostSession, close: async () => undefined })
  })
  let enabled = true,
    confirmations = 0,
    confirmEntered = false
  let confirm: ((value: boolean) => void) | undefined
  const controller = new RemoteRuntimeController({
    micromambaVersion: 'test',
    resolveTarget: (params) => {
      const value = params as Record<string, unknown>
      const selected = identities.get(String(value.runtimeSessionId))
      return selected &&
        value.remoteSessionId === selected.sessionId &&
        value.projectId === selected.projectId
        ? {
            runtimeSessionId: selected.runtimeSessionId,
            sessionId: selected.sessionId,
            projectId: selected.projectId,
            configuredRoot: f.f.runtimeRoot
          }
        : undefined
    },
    listSkills: async () => (enabled ? [{ ...source, insidePlugin: false }] : []),
    resolveBasePackages: async () => ['bash'],
    confirmEnvironment: async () => {
      confirmations += 1
      confirmEntered = true
      if (mode === 'environment-denied') return false
      if (mode === 'environment-pending-stop')
        return new Promise((resolve) => {
          confirm = resolve
        })
      return true
    },
    openWorkspace: async () => ({
      projectHost: host,
      runtimeHost: f.f.host,
      projectRoot: root,
      runtimeRoot: f.f.runtimeRoot,
      micromambaPath: binary,
      execWithInput: createRemoteRuntimeInputExec(async () => ({
        ...f.f.session,
        ...f.hostSession,
        close: async () => undefined
      }))
    })
  })
  function control(
    params: unknown,
    context: PhiHostRequestContext
  ): { signal?: AbortSignal; beforeDispatch(): void } {
    const value = params as Record<string, unknown>
    const selected = identities.get(String(value.runtimeSessionId))!
    assert.ok(selected)
    assert.equal(context.originSessionId, selected.runtimeSessionId)
    assert.equal(value.remoteSessionId, selected.sessionId)
    assert.equal(value.projectId, selected.projectId)
    assert.equal(Object.hasOwn(value, 'signal'), false)
    const binding = resolveRemoteWorkspaceHostBinding({
      sessionId: selected.sessionId,
      projectId: selected.projectId
    }).cacheKey
    return {
      signal: context.signal,
      beforeDispatch: () => {
        context.signal?.throwIfAborted()
        assert.equal(
          resolveRemoteWorkspaceHostBinding({
            sessionId: selected.sessionId,
            projectId: selected.projectId
          }).cacheKey,
          binding
        )
      }
    }
  }
  f.engine.host.register('skills.run', (params, context) =>
    controller.runSkill(params, control(params, context))
  )
  f.engine.host.register('skills.scriptTool', (params, context) =>
    controller.runScriptTool(params, control(params, context))
  )
  f.engine.host.register('skills.cancel', (params) => controller.skills.cancel(params))
  f.engine.host.register('environments.request', (params, context) =>
    controller.requestEnvironment(params, control(params, context))
  )
  f.engine.host.register('environments.cancel', (params) => controller.environments.cancel(params))
  return {
    async resources(identity, signal) {
      signal.throwIfAborted()
      identities.set(identity.runtimeSessionId, identity)
      const listed = await controller.scriptTools({
        runtimeSessionId: identity.runtimeSessionId,
        remoteSessionId: identity.sessionId,
        projectId: identity.projectId
      })
      assert.deepEqual(listed.problems, [])
      return {
        tools: {
          allowedSkills: [source.name],
          skillCatalog: [{ name: source.name, description: 'Tiny trusted server script fixture' }],
          scriptTools: listed.tools,
          scriptApprovalFor: (name, input) => controller.approvalFor(name, input),
          paletteCatalogPath: join(process.cwd(), 'resources/palettes/palettes.yaml')
        }
      }
    },
    async run() {
      await ledgerReady
      let proxy = (await f.createApplicationSession()).session
      let approvalCalls = 0,
        pendingApproval: ((value: 'approved') => void) | undefined
      f.configureApproval({
        shouldGate: () => true,
        requestToolApproval: async (request) => {
          approvalCalls += 1
          if (mode === 'skill-denied') return 'denied'
          if (mode === 'skill-pending-stop')
            return new Promise((resolve) => {
              pendingApproval = resolve
            })
          assert.ok(['remotedemo_write', 'skill_run'].includes(request.toolName))
          return 'approved'
        },
        onEvent: (event) => {
          if (event.type === 'approval_requested')
            f.runners.markNeedsApproval(event.sessionId, event.approvalId, {
              toolName: event.request.toolName,
              summary: event.request.summary
            })
          else if (event.type === 'approval_approved')
            f.runners.markApprovalApproved(event.sessionId, event.approvalId)
          else if (event.type === 'approval_denied')
            f.runners.markApprovalDenied(event.sessionId, event.approvalId)
          else f.runners.markApprovalCancelled(event.sessionId, event.approvalId)
        }
      })
      const execute = async (prompt: string): Promise<void> => {
        const run = f.runners.startRun({
          sessionId: f.phi.sessionId,
          runId: createRunId(),
          execute: () => proxy.prompt(prompt)
        })
        await run.done
      }
      try {
        f.provider.enqueue(
          {
            tool: {
              name: 'env_request',
              args: {
                packages: ['coreutils'],
                environment: 'phi:python@1',
                reason: 'tiny fixture, no network'
              }
            }
          },
          { text: 'Environment settled' }
        )
        const before = readFakeMicromambaInvocations(environmentFixture)
        const pending = execute('Prepare the selected server environment')
        if (mode === 'environment-pending-stop') {
          while (!confirmEntered) await new Promise((resolve) => setTimeout(resolve, 10))
          f.runners.stopRun(f.phi.sessionId)
          await proxy.abort()
          confirm!(true)
        }
        await pending
        assert.equal(confirmations, 1)
        if (mode.startsWith('environment-')) {
          assert.deepEqual(readFakeMicromambaInvocations(environmentFixture), before)
          assert.equal(await f.exists(join(root, '.phi/environments')), false)
          return
        }
        assert.ok(readFakeMicromambaInvocations(environmentFixture).length > before.length)
        const request = f.provider.requests[0] as unknown as {
          tools: Array<{
            function: {
              name: string
              description: string
              parameters: { properties: { skill?: { enum: string[] } } }
            }
          }>
        }
        const generic = request.tools.find((tool) => tool.function.name === 'skill_run')!
        assert.deepEqual(generic.function.parameters.properties.skill!.enum, [source.name])
        assert.match(generic.function.description, /Tiny trusted server script fixture/)
        if (mode === 'skill-revoked') enabled = false
        f.provider.enqueue(
          { tool: { name: 'remotedemo_json', args: { message: 'remote-read' } } },
          ...(mode === 'skill-flow'
            ? [
                {
                  tool: {
                    name: 'remotedemo_write',
                    args: { output: 'approved-script.txt', content: 'server-only' }
                  }
                },
                {
                  tool: {
                    name: 'skill_run',
                    args: { skill: 'remote-demo', script: 'run.sh', args: ['raw-argument'] }
                  }
                }
              ]
            : mode === 'skill-revoked'
              ? []
              : [
                  {
                    tool: {
                      name: 'remotedemo_write',
                      args: { output: 'approved-script.txt', content: 'must-not-write' }
                    }
                  }
                ]),
          { text: 'Scripts settled' }
        )
        const invocations = readFakeMicromambaInvocations(environmentFixture)
        const scripts = execute('Run the trusted declared script in the selected project')
        if (mode === 'skill-pending-stop') {
          while (!pendingApproval) await new Promise((resolve) => setTimeout(resolve, 10))
          f.runners.stopRun(f.phi.sessionId)
          await proxy.abort()
          pendingApproval('approved')
        }
        await scripts
        if (mode === 'skill-flow') {
          assert.equal(await readFile(join(root, 'approved-script.txt'), 'utf8'), 'server-only')
          assert.equal(
            approvalCalls,
            2,
            'declared read promoted to write and generic exec each gate once'
          )
          const saved = readFakeMicromambaInvocations(environmentFixture)
          const beforeRequests = f.provider.requests.length
          const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
          await proxy.dispose()
          f.resume()
          proxy = (await f.createApplicationSession()).session
          assert.equal(f.provider.requests.length, beforeRequests)
          assert.deepEqual(readFakeMicromambaInvocations(environmentFixture), saved)
          assert.equal(
            findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
            reference.journalBasename
          )
          assert.equal(
            readSessionEvents(f.phi.sessionId).filter(
              (event) => event.type === 'approval_requested'
            ).length,
            2
          )
        } else {
          assert.equal(await f.exists(join(root, 'approved-script.txt')), false)
          if (mode === 'skill-revoked')
            assert.deepEqual(readFakeMicromambaInvocations(environmentFixture), invocations)
        }
        assert.equal(await f.exists(join(f.phi.manifest.cwd, 'approved-script.txt')), false)
      } finally {
        await proxy.dispose()
      }
    },
    async close() {
      await host.close()
      await Promise.all(server.sessions.map((session) => session.close()))
      server.cleanup()
    }
  }
}
