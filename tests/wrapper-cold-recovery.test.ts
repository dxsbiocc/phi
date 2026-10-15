import assert from 'node:assert/strict'
import test from 'node:test'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import { findWrapperCompositionEntry } from '../src/main/agent/wrappers/composition/discovery'
import {
  startCompositionRun,
  writeCompositionRemoteSnapshot
} from '../src/main/agent/wrappers/composition/run-record'
import { readWrapperRun } from '../src/main/agent/wrappers/store'
import type { ResolvedRemoteTarget } from '../src/main/agent/wrappers/remote-connection-resolver'
import { WRAPPER_ID, withSandbox } from './helpers/wrapperSandbox'

test('cold Wrapper adoption rejects changed project/profile/connection/root before any remote connection', async () => {
  await withSandbox(async (sandbox) => {
    const entry = findWrapperCompositionEntry(WRAPPER_ID, { agentDir: sandbox.agentDir })!
    assert.ok(entry)
    for (const mismatch of [
      'projectId',
      'hostProfileId',
      'connectionId',
      'workspaceRoot'
    ] as const) {
      let connections = 0
      const run = startCompositionRun({
        entry,
        params: { outdir: 'results' },
        profile: 'singularity',
        originSessionId: 'old-runtime',
        remote: {
          host: 'server',
          workspaceRoot: '/server/project',
          executor: 'remote-background',
          connectionId: 'connection',
          projectId: 'project',
          hostProfileId: 'host'
        },
        agentDir: sandbox.agentDir
      })
      writeCompositionRemoteSnapshot(
        run.runId,
        {
          runId: run.runId,
          remoteRunDir: run.remote!.runDir,
          pid: 12345,
          params: {},
          componentDir: '/server/project/bundles/component',
          logOffset: 0
        },
        sandbox.agentDir
      )
      const resolved: ResolvedRemoteTarget = {
        projectId: 'project',
        hostProfileId: 'host',
        connectionId: 'connection',
        target: {
          connection: { host: 'server' },
          workspaceRoot: '/server/project',
          connectImpl: async () => {
            connections++
            throw new Error('This connection must never open')
          }
        }
      }
      if (mismatch === 'workspaceRoot') resolved.target.workspaceRoot = '/server/rebound'
      else resolved[mismatch] = 'rebound'
      const manager = new WrapperJobManager({
        agentDir: () => sandbox.agentDir,
        discovery: { agentDir: sandbox.agentDir },
        resolveRemoteTarget: () => resolved
      })
      try {
        assert.equal(await manager.adoptRemoteRuns(run.runId), 0, mismatch)
        assert.equal(connections, 0, mismatch + ' opened a remote connection')
        assert.equal(readWrapperRun(run.runId, sandbox.agentDir)?.state, 'lost')
      } finally {
        manager.shutdown()
      }
    }
  })
})
