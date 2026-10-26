import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

import type { JsonValue } from '../../src/shared/kernel-protocol'
import type { KernelProtocolClient } from '../../src/main/agent/engine/kernel-client'
import { loadRemoteWrapperAgent } from '../../src/main/agent/agents/remote-wrapper-agent'
import { downloadRemoteWorkspaceFileToPath } from '../../src/main/agent/remote-workspace-file-download'
import { ensureRemoteProjectAnchor } from '../../src/main/agent/remote-project-anchor'

export const DESKTOP_SERVICES_E2E_HOST_CAPABILITIES = [
  'settings.nextActionSuggestionsEnabled',
  'skills.scriptTools',
  'decisions.evaluate',
  'deliverables.present',
  'wrapperJob.start',
  'wrapperJob.status',
  'wrapperJob.list',
  'wrapperJob.cancel',
  'wrapperJob.wait'
] as const

type WrapperState = 'running' | 'cancelled'

export interface DesktopServicesE2eState {
  presented: Array<{ sessionId?: string; path: string }>
  wrapperCalls: string[]
  wrapperOwner?: string
  wrapperState: WrapperState
}

export function createDesktopServicesE2eState(): DesktopServicesE2eState {
  return { presented: [], wrapperCalls: [], wrapperState: 'running' }
}

function wrapperStatus(state: DesktopServicesE2eState): Record<string, JsonValue> {
  return {
    runId: 'desktop-services-wrapper',
    wrapperId: 'e2e/controlled',
    state: state.wrapperState,
    profile: 'singularity',
    outDir: '/tmp/phi-kernel-e2e-wrapper',
    elapsedSeconds: 1,
    progress: {},
    logTail: 'controlled e2e job'
  }
}

/** Install before hello so the scenario advertises only handlers that actually exist. */
export function configureDesktopServicesE2eClient(
  client: KernelProtocolClient,
  state: DesktopServicesE2eState,
  host: string
): void {
  client.registerHostCapability('settings.nextActionSuggestionsEnabled', () => false)
  client.registerHostCapability('skills.scriptTools', () => ({ tools: [] }))
  client.registerHostCapability('decisions.evaluate', ({ model }) => ({
    choice: 'suitable',
    source: 'model',
    model,
    fallbackReason: 'not_configured'
  }))
  client.registerHostCapability('deliverables.present', (params, context) => {
    const requested = Array.isArray(params.files) ? params.files : []
    const files = requested.map((entry) => {
      const item = entry as Record<string, JsonValue>
      const path = String(item.path)
      state.presented.push({ sessionId: context.sessionId, path })
      return {
        path: `ssh://${host}${path}`,
        displayPath: posix.basename(path),
        bytes: 31,
        ...(typeof item.description === 'string' ? { description: item.description } : {})
      }
    })
    return { files }
  })
  client.registerHostCapability('wrapperJob.start', (params, context) => {
    state.wrapperCalls.push('start')
    state.wrapperOwner = context.sessionId
    state.wrapperState = 'running'
    assert.equal(params.id, 'e2e/controlled')
    assert.notEqual(params.target, 'local')
    return { ok: true, status: wrapperStatus(state) }
  })
  client.registerHostCapability('wrapperJob.status', ({ runId }, context) => {
    state.wrapperCalls.push('status')
    assert.equal(runId, 'desktop-services-wrapper')
    assert.equal(context.sessionId, state.wrapperOwner)
    return wrapperStatus(state)
  })
  client.registerHostCapability('wrapperJob.list', (_params, context) => {
    assert.equal(context.sessionId, state.wrapperOwner)
    return [
      {
        runId: 'desktop-services-wrapper',
        wrapperId: 'e2e/controlled',
        state: state.wrapperState,
        elapsedSeconds: 1
      }
    ]
  })
  client.registerHostCapability('wrapperJob.cancel', ({ runId }, context) => {
    state.wrapperCalls.push('cancel')
    assert.equal(runId, 'desktop-services-wrapper')
    assert.equal(context.sessionId, state.wrapperOwner)
    state.wrapperState = 'cancelled'
    return { ok: true, status: wrapperStatus(state) }
  })
  client.registerHostCapability('wrapperJob.wait', (_params, context) => {
    assert.equal(context.sessionId, state.wrapperOwner)
    return wrapperStatus(state)
  })
}

interface DesktopServicesScenarioClient {
  create(cwd: string, approval: boolean, options?: { phiAgents?: JsonValue[] }): Promise<string>
  prompt(
    sessionId: string,
    text: string
  ): Promise<{ runId: string; status: string; detail?: string }>
  snapshot(sessionId: string): Promise<Record<string, unknown>>
}

interface DesktopServicesFiles {
  readonly paths: { projectA: string }
  write(path: string, content: Uint8Array | string): Promise<void>
}

type Step = <T>(name: string, action: () => Promise<T>) => Promise<T>

export async function runDesktopServicesScenario(options: {
  host: string
  client: DesktopServicesScenarioClient
  provider: {
    enqueue(
      ...replies: Array<{
        text?: string
        tool?: { name: string; id: string; args: Record<string, unknown> }
      }>
    ): void
  }
  files: DesktopServicesFiles
  state: DesktopServicesE2eState
  step: Step
}): Promise<void> {
  const serverFile = posix.join(options.files.paths.projectA, 'desktop-service-result.txt')
  const payload = 'PHI_DESKTOP_SERVICE_TRANSFER_OK\n'
  await options.step('desktop-services server result prepared', () =>
    options.files.write(serverFile, payload)
  )
  const wrapper = loadRemoteWrapperAgent(join(process.cwd(), 'resources', 'agents'))
  assert.ok(wrapper, 'Bundled Wrapper agent is unavailable')
  const sessionId = await options.step('desktop-services kernel session created', () =>
    options.client.create(options.files.paths.projectA, false, {
      // Agent definitions carry optional fields as `undefined`, which protocol frames reject.
      phiAgents: [JSON.parse(JSON.stringify(wrapper)) as JsonValue]
    })
  )

  options.provider.enqueue(
    {
      tool: {
        name: 'present_files',
        id: 'desktop-present',
        args: { files: [{ path: serverFile, description: 'desktop service e2e result' }] }
      }
    },
    {
      tool: {
        name: 'Wrapper',
        id: 'desktop-wrapper-delegate',
        args: {
          task: 'Start the controlled e2e wrapper e2e/controlled, query its status, cancel it, and report the final state.'
        }
      }
    },
    {
      tool: {
        name: 'wrapper_run',
        id: 'desktop-wrapper-run',
        args: { id: 'e2e/controlled', target: 'remote', params: {} }
      }
    },
    {
      tool: {
        name: 'wrapper_status',
        id: 'desktop-wrapper-status',
        args: { run_id: 'desktop-services-wrapper' }
      }
    },
    {
      tool: {
        name: 'wrapper_cancel',
        id: 'desktop-wrapper-cancel',
        args: { run_id: 'desktop-services-wrapper' }
      }
    },
    {
      text: '<phi_agent_result>{"status":"completed","missingInputs":[],"nextAgent":null,"fallbackReason":null}</phi_agent_result>Controlled Wrapper job was started, queried, and cancelled.'
    },
    { text: 'DESKTOP_SERVICES_SCENARIO_COMPLETE' }
  )
  await options.step('present and controlled Wrapper flow completed', async () => {
    const completion = await options.client.prompt(
      sessionId,
      'Present the prepared server result, then delegate the controlled Wrapper lifecycle.'
    )
    assert.equal(completion.status, 'completed', completion.detail)
    assert.deepEqual(options.state.wrapperCalls, ['start', 'status', 'cancel'])
    assert.equal(options.state.wrapperState, 'cancelled')
    assert.deepEqual(options.state.presented, [{ sessionId, path: serverFile }])
    assert.match(
      JSON.stringify(await options.client.snapshot(sessionId)),
      /DESKTOP_SERVICES_SCENARIO_COMPLETE/
    )
  })

  const local = mkdtempSync(join(tmpdir(), 'phi-kernel-desktop-transfer-'))
  try {
    const agentDir = join(local, 'agent')
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    const projectId = 'desktop-services-project'
    const phiSessionId = 'desktop-services-session'
    const anchor = ensureRemoteProjectAnchor(projectId, agentDir)
    const hostProfileId = 'desktop-services-host'
    const destination = join(local, 'downloaded-result.txt')
    await options.step('presented server file downloaded through transfer backend', async () => {
      const result = await downloadRemoteWorkspaceFileToPath(
        {
          sessionId: phiSessionId,
          projectId,
          path: serverFile,
          requestId: 'desktop_services_download'
        },
        destination,
        {
          agentDir,
          getManifest: () =>
            ({
              schemaVersion: 1,
              sessionId: phiSessionId,
              kind: 'project',
              projectId,
              projectLocation: {
                kind: 'ssh',
                hostProfileId,
                remoteRoot: options.files.paths.projectA,
                canonicalRoot: options.files.paths.projectA
              },
              cwd: anchor,
              cwdRealPath: anchor,
              permissionMode: 'auto',
              status: 'idle',
              unreadKind: null,
              messageCount: 0,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              lastActivityAt: new Date(0).toISOString()
            }) as never,
          getProject: () =>
            ({
              id: projectId,
              name: 'Desktop services e2e',
              location: {
                kind: 'ssh',
                hostProfileId,
                remoteRoot: options.files.paths.projectA,
                canonicalRoot: options.files.paths.projectA
              },
              workingDirectory: options.files.paths.projectA,
              workingDirectoryRealPath: options.files.paths.projectA,
              permissionMode: 'auto',
              pathAvailable: true,
              createdAt: new Date(0).toISOString()
            }) as never,
          getHostProfile: () => ({
            id: hostProfileId,
            label: options.host,
            hostAlias: options.host
          })
        }
      )
      assert.equal(result.status, 'saved')
      assert.equal(readFileSync(destination, 'utf8'), payload)
    })
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
}
