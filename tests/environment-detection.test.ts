import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { detectEnvironmentTools, probeCustomToolPath } from '../src/main/agent/environment/detect'
import {
  dismissEnvironmentSummary,
  getEnvironment,
  mergeDetectedWithCustoms,
  redetectEnvironment,
  setEnvironmentToolPath
} from '../src/main/agent/environment/store'

test('detectEnvironmentTools marks tools ready from injected which/runner', () => {
  const tools = detectEnvironmentTools({
    which: (name) => {
      if (name === 'nextflow') return '/opt/nextflow'
      if (name === 'docker') return '/usr/bin/docker'
      if (name === 'micromamba') return '/opt/micromamba'
      if (name === 'jupyter') return '/opt/jupyter'
      if (name === 'Rscript') return '/usr/bin/Rscript'
      return undefined
    },
    runner: (command, args) => {
      if (command === '/opt/nextflow' && args[0] === '-version') return 'nextflow version 24.0.0'
      if (command === '/usr/bin/docker') return 'Docker version 26.0.0'
      if (command === '/opt/micromamba') return '1.5.0'
      if (command === '/opt/jupyter' && args.join(' ') === 'server --version') return '2.14.0'
      if (command === '/opt/jupyter' && args.join(' ') === 'kernelspec list --json') {
        return JSON.stringify({
          kernelspecs: {
            python3: {
              resource_dir: '/k/python3',
              spec: { display_name: 'Python 3', language: 'python', argv: ['python'] }
            }
          }
        })
      }
      if (command === '/usr/bin/Rscript') return 'R scripting front-end version 4.4.0'
      throw new Error(`unexpected ${command} ${args.join(' ')}`)
    }
  })

  const byId = Object.fromEntries(tools.map((tool) => [tool.id, tool]))
  assert.equal(byId.nextflow?.status, 'ready')
  assert.equal(byId.nextflow?.activePath, '/opt/nextflow')
  assert.equal(byId.docker?.status, 'ready')
  assert.equal(byId.micromamba?.status, 'ready')
  assert.equal(byId.jupyter?.status, 'ready')
  assert.match(byId.jupyter?.detail ?? '', /Python/)
  assert.equal(byId.rscript?.status, 'ready')
  assert.equal(byId.singularity?.status, 'missing')
})

test('mergeDetectedWithCustoms prefers validated custom paths', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-env-merge-'))
  const fakeBin = join(agentDir, 'custom-nextflow')
  try {
    writeFileSync(fakeBin, '#!/bin/sh\n')
    const detected = detectEnvironmentTools({
      which: () => undefined,
      runner: () => {
        throw new Error('none')
      }
    })
    const merged = mergeDetectedWithCustoms(
      detected,
      { nextflow: fakeBin },
      {
        runner: (command, args) => {
          if (command === fakeBin && args[0] === '-version') return 'nextflow version 23'
          throw new Error('unexpected')
        }
      }
    )
    const nextflow = merged.find((tool) => tool.id === 'nextflow')
    assert.equal(nextflow?.source, 'custom')
    assert.equal(nextflow?.status, 'ready')
    assert.equal(nextflow?.activePath, fakeBin)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('probeCustomToolPath rejects missing files', () => {
  const probed = probeCustomToolPath('docker', '/no/such/docker')
  assert.equal(probed.status, 'invalid')
  assert.equal(probed.source, 'custom')
})

test('environment store scans once then dismisses summary', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-env-'))
  try {
    const first = getEnvironment(agentDir)
    assert.equal(first.snapshot.firstScanCompleted, true)
    assert.equal(first.showSummary, true)

    const second = getEnvironment(agentDir)
    assert.equal(second.showSummary, true)
    assert.equal(second.snapshot.scannedAt, first.snapshot.scannedAt)

    const dismissed = dismissEnvironmentSummary(agentDir)
    assert.equal(dismissed.summaryDismissed, true)
    assert.equal(getEnvironment(agentDir).showSummary, false)

    const again = redetectEnvironment(agentDir)
    assert.equal(again.firstScanCompleted, true)
    assert.equal(again.summaryDismissed, true)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('setEnvironmentToolPath stores custom nextflow path after probe', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-env-path-'))
  const fakeBin = join(agentDir, 'fake-nextflow')
  try {
    writeFileSync(fakeBin, '#!/bin/sh\n')

    const snapshot = setEnvironmentToolPath('nextflow', fakeBin, agentDir, {
      which: () => undefined,
      runner: (command, args) => {
        if (command === fakeBin && args[0] === '-version') return 'nextflow version test'
        // Fresh detect for other tools — allow failures as missing
        throw new Error('missing')
      }
    })
    const nextflow = snapshot.tools.find((tool) => tool.id === 'nextflow')
    assert.equal(nextflow?.source, 'custom')
    assert.equal(nextflow?.status, 'ready')
    assert.equal(nextflow?.activePath, fakeBin)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})
