import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  dedupeAndOrderMissingToolCandidates,
  discoverMissingToolCandidates,
  parseMissingToolEnvironmentList,
  resolveMissingToolPath,
  type MissingToolHostExecution
} from '../src/main/agent/workspace-host/missing-tool-discovery'

test('parses conda and micromamba environment lists into ordered executable candidates', () => {
  const conda = parseMissingToolEnvironmentList(
    [
      '# conda environments:',
      '#',
      'base                  *  /Users/alice/miniconda3',
      'nextflow                 /data/alice/envs/nextflow',
      ''
    ].join('\n'),
    'nextflow',
    'conda-env'
  )
  const micromamba = parseMissingToolEnvironmentList(
    [
      '  Name       Active  Path',
      '──────────────────────────────',
      '  base       *       /Users/alice/miniconda3',
      '  workflow           /opt/mamba/envs/workflow',
      ''
    ].join('\n'),
    'nextflow',
    'micromamba-env'
  )

  assert.deepEqual(conda, [
    { path: '/Users/alice/miniconda3/bin/nextflow', source: 'conda-env' },
    { path: '/data/alice/envs/nextflow/bin/nextflow', source: 'conda-env' }
  ])
  assert.deepEqual(micromamba, [
    { path: '/Users/alice/miniconda3/bin/nextflow', source: 'micromamba-env' },
    { path: '/opt/mamba/envs/workflow/bin/nextflow', source: 'micromamba-env' }
  ])

  assert.deepEqual(
    dedupeAndOrderMissingToolCandidates([
      ...micromamba,
      { path: '/saved/nextflow', source: 'saved' },
      ...conda,
      { path: '/usr/local/bin/nextflow', source: 'common-location' },
      { path: '/login/bin/nextflow', source: 'login-path' }
    ]),
    [
      { path: '/saved/nextflow', source: 'saved' },
      { path: '/login/bin/nextflow', source: 'login-path' },
      { path: '/Users/alice/miniconda3/bin/nextflow', source: 'conda-env' },
      { path: '/data/alice/envs/nextflow/bin/nextflow', source: 'conda-env' },
      { path: '/opt/mamba/envs/workflow/bin/nextflow', source: 'micromamba-env' },
      { path: '/usr/local/bin/nextflow', source: 'common-location' }
    ]
  )
})

test('resolves absolute executable and environment paths through the host executor', async () => {
  const calls: string[][] = []
  const execution: MissingToolHostExecution = {
    async run(command) {
      calls.push([...command])
      const entered = command[4]
      const stdout =
        entered === '/tools/nextflow' || entered === '/timeout/nextflow'
          ? 'executable\n'
          : entered === '/data/user envs/nextflow'
            ? 'environment\n'
            : ''
      return {
        stdout,
        stderr: '',
        code: stdout ? 0 : 1,
        signal: entered === '/timeout/nextflow' ? 'SIGTERM' : null,
        truncated: false,
        ...(entered === '/timeout/nextflow' ? { terminationReason: 'timeout' as const } : {})
      }
    }
  }

  assert.deepEqual(
    await resolveMissingToolPath({
      enteredPath: '/tools/nextflow',
      tool: 'nextflow',
      cwd: '/workspace',
      execution
    }),
    { ok: true, path: '/tools/nextflow', kind: 'executable' }
  )
  assert.deepEqual(
    await resolveMissingToolPath({
      enteredPath: '  /data/user envs/nextflow/  ',
      tool: 'nextflow',
      cwd: '/workspace',
      execution
    }),
    {
      ok: true,
      path: '/data/user envs/nextflow/bin/nextflow',
      kind: 'environment'
    }
  )
  assert.deepEqual(
    await resolveMissingToolPath({
      enteredPath: '/missing/nextflow',
      tool: 'nextflow',
      cwd: '/workspace',
      execution
    }),
    { ok: false, reason: 'not-executable' }
  )
  assert.deepEqual(
    await resolveMissingToolPath({
      enteredPath: '/timeout/nextflow',
      tool: 'nextflow',
      cwd: '/workspace',
      execution
    }),
    { ok: false, reason: 'host-check-failed' }
  )
  assert.deepEqual(
    await resolveMissingToolPath({
      enteredPath: 'envs/nextflow',
      tool: 'nextflow',
      cwd: '/workspace',
      execution
    }),
    { ok: false, reason: 'path-must-be-absolute' }
  )
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[1].slice(3), [
    'phi-validate-tool-path',
    '/data/user envs/nextflow',
    'nextflow'
  ])
})

test('discovers candidates from every bounded host source without selecting one', async () => {
  const markers: string[] = []
  const execution: MissingToolHostExecution = {
    async run(command) {
      const marker = command[3]
      markers.push(marker)
      let stdout = ''
      let code = 0
      switch (marker) {
        case 'phi-validate-tool-path':
          stdout = command[4] === '/saved/nextflow' ? 'executable\n' : ''
          code = stdout ? 0 : 1
          break
        case 'phi-login-path':
          stdout = '/login/bin/nextflow\n'
          break
        case 'phi-conda-env-list':
          stdout = 'base * /conda/base\nworkflow /conda/envs/workflow\n'
          break
        case 'phi-micromamba-env-list':
          stdout = 'base /conda/base\nanalysis /mamba/envs/analysis\n'
          break
        case 'phi-conda-registry':
          stdout = '/conda/base\n'
          break
        case 'phi-phi-micromamba-envs':
          assert.equal(command[4], '/phi/runtime')
          stdout = '/phi/runtime/envs/phi-nextflow/bin/nextflow\n'
          break
        case 'phi-common-tool-paths':
          stdout = [
            'user-local-bin\t/home/alice/.local/bin/nextflow',
            'common-location\t/opt/apps/bin/nextflow'
          ].join('\n')
          break
        case 'phi-filter-tool-paths':
          stdout = command.slice(4).join('\n') + '\n'
          break
        default:
          throw new Error(`unexpected discovery command: ${command.join(' ')}`)
      }
      return { stdout, stderr: '', code, signal: null, truncated: false }
    }
  }

  const candidates = await discoverMissingToolCandidates({
    tool: 'nextflow',
    savedPath: '/saved/nextflow',
    phiRuntimeRoots: ['/phi/runtime'],
    cwd: '/workspace',
    execution
  })

  assert.deepEqual(candidates, [
    { path: '/saved/nextflow', source: 'saved' },
    { path: '/login/bin/nextflow', source: 'login-path' },
    { path: '/conda/base/bin/nextflow', source: 'conda-env' },
    { path: '/conda/envs/workflow/bin/nextflow', source: 'conda-env' },
    { path: '/mamba/envs/analysis/bin/nextflow', source: 'micromamba-env' },
    { path: '/phi/runtime/envs/phi-nextflow/bin/nextflow', source: 'phi-micromamba-env' },
    { path: '/home/alice/.local/bin/nextflow', source: 'user-local-bin' },
    { path: '/opt/apps/bin/nextflow', source: 'common-location' }
  ])
  assert.deepEqual(
    new Set(markers),
    new Set([
      'phi-validate-tool-path',
      'phi-login-path',
      'phi-conda-env-list',
      'phi-micromamba-env-list',
      'phi-conda-registry',
      'phi-phi-micromamba-envs',
      'phi-common-tool-paths',
      'phi-filter-tool-paths'
    ])
  )
  assert.ok(candidates.every((candidate) => !Object.hasOwn(candidate, 'selected')))
})

test('finds conda environments from conda’s own registry when conda is not on the login PATH', async () => {
  const execution: MissingToolHostExecution = {
    async run(command) {
      const marker = command[3]
      let stdout = ''
      if (marker === 'phi-conda-registry') {
        stdout = '/data/miniconda3\n/data/miniconda3/envs/nextflow\n'
      } else if (marker === 'phi-filter-tool-paths') {
        stdout = command
          .slice(4)
          .filter((path) => path.includes('/envs/nextflow/'))
          .join('\n')
      }
      return { stdout, stderr: '', code: stdout ? 0 : 1, signal: null, truncated: false }
    }
  }

  const candidates = await discoverMissingToolCandidates({
    tool: 'nextflow',
    cwd: '/workspace',
    execution
  })

  assert.deepEqual(candidates, [
    { path: '/data/miniconda3/envs/nextflow/bin/nextflow', source: 'conda-env' }
  ])
})

test('returns fewer candidates when independent discovery sources fail or time out', async () => {
  const execution: MissingToolHostExecution = {
    async run(command, options) {
      assert.equal(options.timeoutMs, 25)
      const marker = command[3]
      if (marker === 'phi-login-path') {
        return {
          stdout: '/login/bin/jupyter\n',
          stderr: '',
          code: 0,
          signal: null,
          truncated: false
        }
      }
      if (marker === 'phi-conda-env-list' || marker === 'phi-phi-micromamba-envs') {
        throw new Error('probe unavailable')
      }
      if (marker === 'phi-common-tool-paths') {
        return {
          stdout: 'common-location\t/opt/partial/bin/jupyter\n',
          stderr: '',
          code: 0,
          signal: 'SIGTERM',
          truncated: false,
          terminationReason: 'timeout'
        }
      }
      return { stdout: '', stderr: 'missing', code: 1, signal: null, truncated: false }
    }
  }

  assert.deepEqual(
    await discoverMissingToolCandidates({
      tool: 'jupyter',
      savedPath: 'relative/jupyter',
      phiRuntimeRoots: ['/phi/runtime'],
      cwd: '/workspace',
      timeoutMs: 25,
      execution
    }),
    [{ path: '/login/bin/jupyter', source: 'login-path' }]
  )
})
