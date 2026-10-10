import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { prepareRemoteSkillBundle } from '../src/main/agent/remote-runtime/skill-bundle'
import { createRemoteRuntimeFixture, writeTestSkill } from './helpers/remoteRuntimeFixture'

test('remote skill bundle rejects a symlink destination without deleting its target', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const skill = writeTestSkill(fixture)
    const bundle = await prepareRemoteSkillBundle(
      skill.dir,
      fixture.runtimeRoot,
      fixture.workspace.runtimeHost
    )
    const envs = join(fixture.runtimeRoot, 'envs')
    const sentinel = join(envs, 'sentinel.txt')
    mkdirSync(envs, { recursive: true })
    writeFileSync(sentinel, 'keep')
    const destination = join(fixture.runtimeRoot, bundle.relativeDir)
    rmSync(destination, { recursive: true, force: true })
    symlinkSync(envs, destination, 'dir')

    await assert.rejects(
      prepareRemoteSkillBundle(skill.dir, fixture.runtimeRoot, fixture.workspace.runtimeHost),
      /符号链接/u
    )
    assert.equal(existsSync(sentinel), true)
  } finally {
    fixture.cleanup()
  }
})

test('remote skill bundle cancellation interrupts a queued publication', async () => {
  const fixture = createRemoteRuntimeFixture()
  const skill = writeTestSkill(fixture)
  const host = fixture.workspace.runtimeHost
  const originalRun = host.exec.run
  let releaseFirst = (): void => undefined
  let markEntered = (): void => undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  let destinationChecks = 0
  host.exec.run = async (...args) => {
    if (args[0].includes('phi-skill-destination') && destinationChecks++ === 0) {
      markEntered()
      await firstGate
    }
    return originalRun(...args)
  }
  const first = prepareRemoteSkillBundle(skill.dir, fixture.runtimeRoot, host)
  await entered
  const controller = new AbortController()
  const second = prepareRemoteSkillBundle(skill.dir, fixture.runtimeRoot, host, controller.signal)
  controller.abort()
  try {
    await assert.rejects(
      Promise.race([
        second,
        delay(250).then(() => {
          throw new Error('cancellation waited for the bundle lock')
        })
      ]),
      /aborted/u
    )
  } finally {
    releaseFirst()
    await Promise.allSettled([first, second])
    fixture.cleanup()
  }
})

test('remote skill bundle repairs an extra file before reuse', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const skill = writeTestSkill(fixture)
    const first = await prepareRemoteSkillBundle(
      skill.dir,
      fixture.runtimeRoot,
      fixture.workspace.runtimeHost
    )
    const extra = join(fixture.runtimeRoot, first.relativeDir, 'scripts', '.injected.txt')
    writeFileSync(extra, 'unexpected')

    const reused = await prepareRemoteSkillBundle(
      skill.dir,
      fixture.runtimeRoot,
      fixture.workspace.runtimeHost
    )

    assert.equal(reused.hash, first.hash)
    assert.equal(existsSync(extra), false)
  } finally {
    fixture.cleanup()
  }
})
