import { runWrapperBoundaryScenario, type WrapperBoundaryContext } from './facadeWrapperBoundaries'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import { FAKE_NEXTFLOW, WRAPPER_ID, seedGffreadPackage } from './wrapperSandbox'
import { WrapperJobManager } from '../../src/main/agent/wrappers/composition/job-manager'
import {
  createWrapperJobHostScope,
  wrapperJobHostHandlers
} from '../../src/main/agent/wrappers/composition/job-host-handlers'
import { resetWrapperCompositionCatalogCache } from '../../src/main/agent/wrappers/composition/discovery'
import { listWrapperRuns, readWrapperRun } from '../../src/main/agent/wrappers/store'
import { getProject, type Project } from '../../src/main/agent/projects'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import {
  createRunId,
  appendSessionEvent,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import { APP_RPC_NOTEBOOK_TOOL_NAMES } from '../../src/main/agent/remote-session-routing'
import { WRAPPER_COMPOSITION_TOOL_NAMES } from '../../src/main/agent/wrappers/composition/tools'
import { createLocalShellSession } from './localShellSession'
import { validateRemotePresentedFiles } from '../../src/main/agent/deliverables/remote-present-files'
import type { ResolvedRemoteTarget } from '../../src/main/agent/wrappers/remote-connection-resolver'
import type { WrapperTargetDoctorSnapshot } from '../../src/main/agent/wrappers/target-policy'
import type { RuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    assert.ok(Date.now() - started < 15000, 'Wrapper scenario did not reach its boundary')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runApplicationWrapperScenario(
  f: FacadeMetadataFixture,
  mode: string
): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR!,
    root = f.f.scope.projectRoot
  seedGffreadPackage(agentDir)
  await mkdir(join(root, 'tests/data'), { recursive: true })
  await writeFile(
    join(root, 'tests/data/genome.gff3'),
    '##gff-version 3\nchr1\ttest\tgene\t1\t10\t.\t+\t.\tID=tiny\n'
  )
  resetWrapperCompositionCatalogCache()
  const nextflow = join(root, 'tiny-nextflow')
  await writeFile(
    nextflow,
    FAKE_NEXTFLOW.replace(
      'const gate = process.env.FAKE_NF_GATE',
      "const gate = path.join(path.dirname(params.outdir), 'allow-finish')"
    )
  )
  await chmod(nextflow, 0o700)
  const origins = new Map<string, { phiSessionId: string }>()
  let proxy: RuntimeAgentSession = (await f.createApplicationSession()).session
  origins.set(proxy.runtimeSessionId, { phiSessionId: f.phi.sessionId })
  const project = getProject(f.phi.manifest.projectId!)!
  if (project.location.kind !== 'ssh') throw new Error('Expected selected SSH project')
  const controls: WrapperBoundaryContext['controls'] = {
    doctorEntered: false,
    startSettled: false,
    waitEntered: false,
    launchCommands: []
  }
  const projectForOrigin = (origin: string | undefined): Project | undefined => {
    const phi = origins.get(origin ?? '')?.phiSessionId
    const manifest = phi ? findPhiSessionById(phi) : undefined
    return manifest?.projectId ? getProject(manifest.projectId) : undefined
  }
  const targetForProject = (selected: Project): ResolvedRemoteTarget => {
    if (selected.location.kind !== 'ssh') throw new Error('Expected SSH wrapper target')
    return {
      projectId: selected.id,
      hostProfileId: selected.location.hostProfileId,
      connectionId: 'fixture-selected',
      target: {
        connection: { host: 'synthetic-no-ssh' },
        workspaceRoot: selected.location.canonicalRoot,
        hpc: { scheduler: 'local', runtime: 'singularity', nextflowBin: nextflow },
        connectImpl: async () => {
          const session = createLocalShellSession(
            selected.location.kind === 'ssh' ? selected.location.canonicalRoot : ''
          )
          const exec = session.exec
          session.exec = async (command) => {
            if (command.includes('setsid bash') || command.startsWith('sbatch '))
              controls.launchCommands.push(command)
            return exec(command)
          }
          return session
        },
        pollIntervalMs: 20,
        skipPreflight: true
      }
    }
  }
  const doctor: WrapperTargetDoctorSnapshot = {
    report: {
      hostProfileId: project.location.hostProfileId,
      checkedAt: new Date().toISOString(),
      ok: true,
      checks: [
        'ssh',
        'sftp',
        'path',
        'path_read',
        'path_write',
        'shell',
        'nextflow',
        'java',
        'runtime',
        'login_controller'
      ].map((id) => ({ id, status: 'ok', message: id }))
    },
    remotePath: root,
    scheduler: 'local',
    controller: 'login',
    runtime: 'singularity'
  }
  const jobs = new WrapperJobManager({
    agentDir: () => agentDir,
    progressThrottleMs: 0,
    killGraceMs: 200,
    resolveProjectForRun: projectForOrigin,
    resolveRemoteTarget: (request) => {
      const selected = request.projectId
        ? getProject(request.projectId)
        : projectForOrigin(request.originSessionId)
      return selected ? targetForProject(selected) : { reason: 'unknown selected project' }
    },
    checkRemoteEnvironment: async ({ resolved }) => {
      controls.doctorEntered = true
      await controls.holdDoctor
      return { ...doctor, remotePath: resolved.target.workspaceRoot }
    }
  })
  const startJob = jobs.start.bind(jobs),
    waitJob = jobs.wait.bind(jobs)
  jobs.start = async (...args): ReturnType<WrapperJobManager['start']> => {
    controls.startSettled = false
    try {
      return await startJob(...args)
    } finally {
      controls.startSettled = true
    }
  }
  jobs.wait = (...args): ReturnType<WrapperJobManager['wait']> => {
    if (args[2]?.signal) controls.waitEntered = true
    return waitJob(...args)
  }
  const detach: Array<() => void> = []
  for (const [method, handler] of Object.entries(
    wrapperJobHostHandlers(jobs, {
      scopeFor: (context) => {
        const origin = origins.get(context?.originSessionId ?? '')
        assert.ok(origin && context?.signal)
        const selectedProject = projectForOrigin(context.originSessionId)!
        const target = targetForProject(selectedProject)
        const binding = resolveRemoteWorkspaceHostBinding({
          sessionId: origin.phiSessionId,
          projectId: selectedProject.id
        })
        return createWrapperJobHostScope({
          originSessionId: context.originSessionId!,
          phiSessionId: origin.phiSessionId,
          projectId: selectedProject.id,
          hostProfileId: target.hostProfileId!,
          host: target.target.connection.host,
          workspaceRoot: target.target.workspaceRoot,
          signal: context.signal,
          readRun: (runId) => readWrapperRun(runId, agentDir),
          resolveOrigin: (id) => origins.get(id ?? ''),
          assertCurrent: () =>
            assert.equal(
              resolveRemoteWorkspaceHostBinding({
                sessionId: origin.phiSessionId,
                projectId: selectedProject.id
              }).cacheKey,
              binding.cacheKey,
              'Wrapper host binding changed'
            )
        })
      }
    })
  ))
    detach.push(f.engine.host.register(method, handler))
  detach.push(
    f.engine.host.register('deliverables.present', async (raw, context) => {
      const request = raw as { runtimeSessionId: string; toolCallId: string; files: unknown }
      assert.equal(context.originSessionId, request.runtimeSessionId)
      assert.equal(context.toolCallId, request.toolCallId)
      assert.ok(context.signal)
      context.signal.throwIfAborted()
      const files = await validateRemotePresentedFiles(
        { sessionId: f.phi.sessionId, projectId: project.id },
        request.files,
        {
          connectHost: async () => createLocalShellSession(root)
        }
      )
      context.signal.throwIfAborted()
      appendSessionEvent(f.phi.sessionId, {
        type: 'files_presented',
        runId: f.runners.getActiveRun(f.phi.sessionId)!.runId,
        toolCallId: request.toolCallId,
        files
      })
      return { files }
    })
  )
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: () => 'approved',
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
  const prompt = async (text: string): Promise<void> => {
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt(text)
    })
    await run.done
    assert.equal(run.outcome, 'completed')
  }
  try {
    if (mode !== 'wrapper-flow') {
      await runWrapperBoundaryScenario(
        { f, jobs, proxy, project, origins, root, agentDir, controls, waitFor },
        mode
      )
      return
    }
    f.provider.enqueue(
      { tool: { name: 'wrapper_search', args: { query: 'gffread' } } },
      { tool: { name: 'wrapper_inspect', args: { id: WRAPPER_ID } } },
      {
        tool: {
          name: 'wrapper_run',
          args: {
            id: WRAPPER_ID,
            params: { gff: 'tests/data/genome.gff3' },
            continue_when_done: false
          }
        }
      },
      { text: 'Remote wrapper accepted in background' }
    )
    await prompt('Find, inspect and start the selected project wrapper')
    const roster = (f.provider.requests[0].tools as Array<{ function?: { name: string } }>).map(
      (tool) => tool.function?.name
    )
    for (const name of [
      ...APP_RPC_NOTEBOOK_TOOL_NAMES,
      ...WRAPPER_COMPOSITION_TOOL_NAMES,
      'present_files'
    ])
      assert.ok(roster.includes(name), `Missing actual app tool ${name}`)
    assert.equal(roster.includes('notebook_run_cell'), true)
    const [stored] = listWrapperRuns(agentDir)
    assert.ok(stored?.remote)
    assert.equal(stored.remote.projectId, project.id)
    assert.equal(stored.originSessionId, proxy.runtimeSessionId)
    await waitFor(async () => {
      const status = await jobs.status(stored.runId)
      if (status?.state === 'failed' || status?.state === 'lost')
        throw new Error(JSON.stringify(status))
      return existsSync(join(readWrapperRun(stored.runId, agentDir)!.remote!.runDir, 'launch.sh'))
    })
    const runDir = readWrapperRun(stored.runId, agentDir)!.remote!.runDir
    await writeFile(join(runDir, 'allow-finish'), '')
    await jobs.wait(stored.runId, 15000)
    assert.equal((await jobs.status(stored.runId))?.state, 'completed')
    const artifact = join(runDir, 'results/gffread/out.gtf')
    assert.equal(await readFile(artifact, 'utf8'), 'x')
    f.provider.enqueue(
      { tool: { name: 'wrapper_status', args: { run_id: stored.runId } } },
      { tool: { name: 'wrapper_wait', args: { run_id: stored.runId, timeout_seconds: 1 } } },
      {
        tool: {
          name: 'present_files',
          args: { files: [{ path: artifact, description: 'Remote wrapper result' }] }
        }
      },
      { text: 'Verified server result' }
    )
    await prompt('Check the wrapper and present its server artifact')
    const presented = readSessionEvents(f.phi.sessionId).filter(
      (event) => event.type === 'files_presented'
    )
    assert.equal(presented.length, 1)
    const files = presented[0].files as Array<{ path: string }>
    assert.equal(files[0].path, `ssh://synthetic-no-ssh${artifact}`)
    assert.notEqual(files[0].path, artifact)
    const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
    const before = f.provider.requests.length
    await proxy.dispose()
    f.resume()
    proxy = (await f.createApplicationSession()).session
    origins.set(proxy.runtimeSessionId, { phiSessionId: f.phi.sessionId })
    assert.equal(
      findPhiSessionById(f.phi.sessionId)!.runtimeRef!.ompSessionId,
      reference.ompSessionId
    )
    assert.equal(f.provider.requests.length, before)
    f.provider.enqueue(
      { tool: { name: 'wrapper_status', args: { run_id: stored.runId } } },
      { tool: { name: 'present_files', args: { files: [{ path: artifact }] } } },
      { text: 'Restored same remote job and artifact' }
    )
    await prompt('Inspect the same existing job after explicit recovery')
    assert.equal(
      listWrapperRuns(agentDir).length,
      1,
      'recovery cannot implicitly start another job'
    )
    assert.equal(
      readSessionEvents(f.phi.sessionId).filter((event) => event.type === 'files_presented').length,
      2
    )
    console.log(
      'actual application Wrapper search/inspect/remote job/status/wait/present and same-journal recovery passed'
    )
  } finally {
    for (const run of listWrapperRuns(agentDir)) {
      await jobs.cancel(run.runId)
      await jobs.wait(run.runId, 2000)
    }
    jobs.shutdown()
    for (const release of detach) release()
  }
}
