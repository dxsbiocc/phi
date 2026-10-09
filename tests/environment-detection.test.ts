import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HOST_UNMANAGED,
  detectEnvironmentHostTools,
  detectHostDependencies,
  detectEnvironmentTools,
  probeCustomToolPath,
  type ManagedToolState
} from '../src/main/agent/environment/detect'
import {
  dismissEnvironmentSummary,
  getCustomToolPath,
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

test('host dependency probing requires a reachable Docker daemon and reports versions', () => {
  const dependencies = detectHostDependencies({
    which: (name) => {
      if (name === 'docker') return '/usr/local/bin/docker'
      if (name === 'apptainer') return '/usr/local/bin/apptainer'
      return undefined
    },
    runner: (command, args) => {
      if (command.endsWith('/docker') && args[0] === 'info') return '27.2.1\n'
      if (command.endsWith('/apptainer')) return 'apptainer version 1.3.5\n'
      throw new Error(`unexpected ${command} ${args.join(' ')}`)
    }
  })

  assert.deepEqual(
    dependencies.map(({ id, status, version }) => ({ id, status, version })),
    [
      { id: 'docker', status: 'ready', version: '27.2.1' },
      { id: 'singularity', status: 'ready', version: 'apptainer version 1.3.5' }
    ]
  )
})

test('host dependency probing distinguishes a Docker CLI from a reachable daemon', () => {
  const dependencies = detectHostDependencies({
    which: (name) => (name === 'docker' ? '/usr/local/bin/docker' : undefined),
    runner: (_command, args) => {
      if (args[0] === '--version') return 'Docker version 27.2.1'
      throw new Error('Cannot connect to the Docker daemon')
    }
  })
  const docker = dependencies.find((dependency) => dependency.id === 'docker')
  assert.equal(docker?.status, 'unavailable')
  assert.equal(docker?.version, 'Docker version 27.2.1')
  assert.match(docker?.messages?.[0] ?? '', /daemon/)
})

test('host kernels remain discoverable without a host Jupyter Server', () => {
  const options = {
    which: (name: string) => (name === 'jupyter' ? '/opt/jupyter' : undefined),
    runner: (_command: string, args: string[]): string => {
      if (args.join(' ') === 'kernelspec list --json') {
        return JSON.stringify({
          kernelspecs: {
            lab: {
              resource_dir: '/host/kernels/lab',
              spec: { display_name: 'Lab Python', language: 'python' }
            }
          }
        })
      }
      throw new Error('Jupyter Server is not installed')
    }
  }
  const tools = detectEnvironmentTools(options)
  const hostTools = detectEnvironmentHostTools(tools, {}, options)
  const jupyter = hostTools.find((tool) => tool.id === 'jupyter')
  assert.equal(jupyter?.status, 'ready')
  assert.deepEqual(jupyter?.kernels, [
    {
      id: 'lab',
      displayName: 'Lab Python',
      language: 'python',
      path: '/host/kernels/lab'
    }
  ])
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
          if (command === fakeBin && args[0] === '-version') {
            return '      version 25.10.0 build 10289'
          }
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
    assert.equal(first.snapshot.hostDependencies.length, 2)
    assert.equal(first.snapshot.hostTools.length, 2)
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

test('reading a legacy snapshot drops removed host dependencies without requiring a rescan', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-env-legacy-dependencies-'))
  try {
    writeFileSync(
      join(agentDir, 'environment.json'),
      JSON.stringify({
        firstScanCompleted: true,
        scannedAt: '2026-10-03T05:00:31.000Z',
        tools: [{ id: 'jupyter', label: 'Jupyter', status: 'missing', source: 'none' }],
        hostDependencies: [
          { id: 'docker', label: 'Docker', status: 'ready', path: '/usr/local/bin/docker' },
          { id: 'libreoffice', label: 'LibreOffice', status: 'missing' }
        ],
        hostTools: []
      })
    )

    const snapshot = getEnvironment(agentDir).snapshot
    assert.deepEqual(
      snapshot.hostDependencies.map((dependency) => dependency.id),
      ['docker']
    )
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
        if (command === fakeBin && args[0] === '-version') return '      version 26.04.6 build 1'
        // Fresh detect for other tools — allow failures as missing
        throw new Error('missing')
      }
    })
    const nextflow = snapshot.tools.find((tool) => tool.id === 'nextflow') as
      ManagedToolState | undefined
    assert.equal(nextflow?.source, 'custom')
    assert.equal(nextflow?.status, 'ready')
    assert.equal(nextflow?.activePath, fakeBin)
    assert.equal(nextflow?.detectedVersion, '26.04.6')
    assert.equal(nextflow?.management, 'host-unmanaged')
    assert.equal(nextflow?.detail, HOST_UNMANAGED)
    assert.equal(getCustomToolPath('nextflow', agentDir), fakeBin)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('setEnvironmentToolPath stores an explicitly selected host Jupyter Server', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-env-jupyter-path-'))
  const fakeBin = join(agentDir, 'jupyter')
  try {
    writeFileSync(fakeBin, '#!/bin/sh\n')
    const snapshot = setEnvironmentToolPath('jupyter', fakeBin, agentDir, {
      which: () => undefined,
      runner: (command, args) => {
        if (command === fakeBin && args.join(' ') === 'server --version') return '2.14.0'
        if (command === fakeBin && args.join(' ') === 'kernelspec list --json') {
          return JSON.stringify({
            kernelspecs: {
              python3: {
                resource_dir: '/host/kernels/python3',
                spec: { display_name: 'Python 3', language: 'python' }
              }
            }
          })
        }
        throw new Error('missing')
      }
    })

    const jupyter = snapshot.hostTools.find((tool) => tool.id === 'jupyter')
    assert.equal(jupyter?.selected, true)
    assert.equal(jupyter?.path, fakeBin)
    assert.equal(jupyter?.version, '2.14.0')
    assert.equal(getCustomToolPath('jupyter', agentDir), fakeBin)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('a custom nextflow older than the wrapper minimum is invalid and cannot be set', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-env-old-nf-'))
  const fakeBin = join(agentDir, 'old-nextflow')
  try {
    writeFileSync(fakeBin, '#!/bin/sh\n')
    const runner = (command: string, args: string[]): string => {
      if (command === fakeBin && args[0] === '-version') return '      version 22.10.6 build 5843'
      throw new Error('missing')
    }
    const probed = probeCustomToolPath('nextflow', fakeBin, { runner })
    assert.equal(probed.status, 'invalid')
    assert.equal(probed.management, undefined)
    assert.match(probed.messages?.[0] ?? '', /22\.10\.6/)
    assert.match(probed.messages?.[0] ?? '', /25\.04\.0/)

    assert.throws(
      () =>
        setEnvironmentToolPath('nextflow', fakeBin, agentDir, { which: () => undefined, runner }),
      /22\.10\.6.*25\.04\.0/
    )
    assert.equal(getCustomToolPath('nextflow', agentDir), undefined)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('a custom nextflow whose version cannot be read is invalid', () => {
  const probed = probeCustomToolPath('nextflow', process.execPath, {
    runner: () => 'N E X T F L O W\n'
  })
  assert.equal(probed.status, 'invalid')
  assert.match(probed.messages?.[0] ?? '', /无法从 nextflow -version 读出版本/)
})
