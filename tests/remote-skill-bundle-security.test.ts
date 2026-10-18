import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  prepareRemoteSkillBundle,
  prepareRemoteSkillBundleFiles
} from '../src/main/agent/remote-runtime/skill-bundle'
import { createRemoteRuntimeFixture, writeTestSkill } from './helpers/remoteRuntimeFixture'

test('remote skill bundle publishes a discovered server file snapshot', async () => {
  const fixture = createRemoteRuntimeFixture()
  const content = Buffer.from('server skill\n')
  try {
    const bundle = await prepareRemoteSkillBundleFiles(
      [
        {
          relativePath: 'SKILL.md',
          content,
          contentHash: '629e5d61a86594225feaffffb03cb38e3abec2e74d929ed0dc59b02b7dd02a2d',
          executable: false
        }
      ],
      fixture.workspace
    )

    assert.equal(
      Buffer.compare(
        Buffer.from('server skill\n'),
        readFileSync(join(fixture.runtimeRoot, bundle.relativeDir, 'SKILL.md'))
      ),
      0
    )
  } finally {
    fixture.cleanup()
  }
})

test('remote skill bundle rejects traversal in a discovered server file snapshot', async () => {
  const fixture = createRemoteRuntimeFixture()
  const content = Buffer.from('escape\n')
  const sentinel = join(fixture.runtimeRoot, 'escape.txt')
  writeFileSync(sentinel, 'keep')
  try {
    await assert.rejects(
      prepareRemoteSkillBundleFiles(
        [
          {
            relativePath: '../escape.txt',
            content,
            contentHash: '6471c588e03b49ae22dd3eae13bf88ef36a2b1a5eced7b9cfbeeb9af1d41522f',
            executable: false
          }
        ],
        fixture.workspace
      ),
      /path/u
    )
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
  } finally {
    fixture.cleanup()
  }
})

test('remote skill bundle rejects a symlink destination without deleting its target', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const skill = writeTestSkill(fixture)
    const bundle = await prepareRemoteSkillBundle(skill.dir, fixture.workspace)
    const envs = join(fixture.runtimeRoot, 'envs')
    const sentinel = join(envs, 'sentinel.txt')
    mkdirSync(envs, { recursive: true })
    writeFileSync(sentinel, 'keep')
    const destination = join(fixture.runtimeRoot, bundle.relativeDir)
    rmSync(destination, { recursive: true, force: true })
    symlinkSync(envs, destination, 'dir')

    await assert.rejects(prepareRemoteSkillBundle(skill.dir, fixture.workspace), /symlink/u)
    assert.equal(existsSync(sentinel), true)
  } finally {
    fixture.cleanup()
  }
})

test('remote skill bundle cancellation interrupts a queued publication', async () => {
  const fixture = createRemoteRuntimeFixture()
  const skill = writeTestSkill(fixture)
  const originalRun = fixture.workspace.execWithInput
  let releaseFirst = (): void => undefined
  let markEntered = (): void => undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  let destinationChecks = 0
  fixture.workspace.execWithInput = async (...args) => {
    if (args[0].includes('phi_repair') && destinationChecks++ === 0) {
      markEntered()
      await firstGate
    }
    return originalRun(...args)
  }
  const first = prepareRemoteSkillBundle(skill.dir, fixture.workspace)
  await entered
  const controller = new AbortController()
  const second = prepareRemoteSkillBundle(skill.dir, fixture.workspace, controller.signal)
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
    const first = await prepareRemoteSkillBundle(skill.dir, fixture.workspace)
    const extra = join(fixture.runtimeRoot, first.relativeDir, 'scripts', '.injected.txt')
    writeFileSync(extra, 'unexpected')

    const reused = await prepareRemoteSkillBundle(skill.dir, fixture.workspace)

    assert.equal(reused.hash, first.hash)
    assert.equal(existsSync(extra), false)
  } finally {
    fixture.cleanup()
  }
})
