import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  createPhiExtensionBundle,
  ensurePhiExtensionDeployment
} from '../../src/main/agent/engine/rpc/extension-deployment'
import { ensureRemoteOmpDeployment } from '../../src/main/agent/engine/rpc/runtime-deployment'
import type { RemoteStartupDiagnostic } from '../../src/main/agent/engine/rpc/remote-startup-diagnostics'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { seedPreparedRemoteHelper } from './preparedRemoteHelper'

const delayMs = Number(process.env.PHI_REMOTE_STARTUP_COMMAND_DELAY_MS ?? '0')
assert.ok(Number.isFinite(delayMs) && delayMs >= 0)

const reports: RemoteStartupDiagnostic[] = []
const fixture = await facadeMetadataFixture({
  applicationRouting: {
    agents: [],
    commandDelayMs: delayMs,
    // Drive the REAL openRemoteRuntimeWorkspace: runtime-root resolution and the managed-helper
    // bootstrap run their production code instead of an injected ready root/helper.
    realWorkspace: true,
    startupDiagnostics: (report) => reports.push(report)
  }
})

let primaryFailure: unknown
try {
  // Match the slow-host case: immutable binary/extension content is already installed,
  // so the measured attach still performs all production verification and publication.
  await ensureRemoteOmpDeployment(fixture.f.options)
  const bundle = await createPhiExtensionBundle(
    join(process.cwd(), 'src/main/agent/engine/phi-extension')
  )
  await ensurePhiExtensionDeployment({ ...fixture.f.deploymentOptions, bundle })

  await seedPreparedRemoteHelper({
    runtimeRoot: fixture.f.runtimeRoot,
    hostAlias: 'synthetic-no-ssh'
  })

  let created: Awaited<ReturnType<typeof fixture.createApplicationSession>>
  try {
    created = await fixture.createApplicationSession()
  } catch (error) {
    // A failed startup still reports what it spent, so a regression is attributable.
    if (reports.length > 0)
      process.stdout.write(`REMOTE_STARTUP_DIAGNOSTIC ${JSON.stringify(reports[0])}\n`)
    throw error
  }
  await created.session.dispose()
  assert.equal(reports.length, 1)
  assert.equal(reports[0].status, 'ready')
  process.stdout.write(`REMOTE_STARTUP_DIAGNOSTIC ${JSON.stringify(reports[0])}\n`)
} catch (error) {
  primaryFailure = error
  throw error
} finally {
  await fixture.close().catch((error) => {
    if (!primaryFailure) throw error
  })
}
