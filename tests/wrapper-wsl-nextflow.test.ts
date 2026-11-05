import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import test from 'node:test'

import { wslProcessSupervisorArgs } from '../src/main/agent/envs/wsl-process-supervisor'
import { toLinuxPath, type WslRuntime } from '../src/main/agent/envs/wsl'
import { prepareNextflowProfile } from '../src/main/agent/wrappers/composition/conda-profile'
import { resolveNextflowLaunch } from '../src/main/agent/wrappers/composition/nextflow-launch'
import {
  wslNextflowParams,
  wslNextflowProcess
} from '../src/main/agent/wrappers/composition/nextflow-wsl'

const WSL: WslRuntime = {
  ready: { status: 'ready', executable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Phi Ubuntu' },
  linuxHome: '/home/phi',
  linuxRoot: '/home/phi/runtime',
  linuxMicromamba: '/home/phi/runtime/bin/micromamba'
}

const mapPath = (path: string): string => toLinuxPath(path, WSL.ready.distro)

test('WSL Nextflow translates declared paths while preserving text options and URLs', () => {
  const params = {
    input: 'D:\\项目 1\\*.bam',
    outdir: 'results\\qc',
    reference: 'https://example.com/ref.fa',
    label: 'D:\\literal\\option'
  }
  const result = wslNextflowParams(params, ['input', 'outdir', 'reference'], mapPath)
  assert.deepEqual(result, {
    ...params,
    input: '/mnt/d/项目 1/*.bam',
    outdir: 'results/qc'
  })
  assert.equal(params.input, 'D:\\项目 1\\*.bam')
})

test('Windows managed Nextflow rejects container profiles before looking for host tools', async () => {
  const result = await resolveNextflowLaunch({
    platform: 'win32-x64',
    profile: 'docker',
    hostNextflowPath: () => undefined
  })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /WSL2.*docker.*conda/u)
})

test('WSL Nextflow uses the bound distro, Linux micromamba config, and native work directory', () => {
  const command = '/home/phi/runtime/envs/nextflow/bin/nextflow'
  const profile = prepareNextflowProfile(
    'conda',
    'C:\\Phi',
    {
      PATH: '/home/phi/runtime/envs/nextflow/bin:/usr/bin:/bin',
      CONDA_PREFIX: '/old'
    },
    undefined,
    WSL
  )
  assert.match(profile.config ?? '', /cacheDir = '\/home\/phi\/runtime\/nextflow-conda'/u)
  assert.equal(profile.env.MAMBARC, '/home/phi/runtime/mambarc.linux-x64')
  assert.match(profile.env.PATH, /^\/home\/phi\/runtime\/bin:/u)
  assert.equal(profile.env.CONDA_PREFIX, undefined)

  const plan = wslNextflowProcess(
    WSL,
    {
      command,
      args: ['run', 'wrapper/main.nf', '-params-file', 'C:\\Temp\\参数.json'],
      cwd: 'D:\\项目 1',
      env: profile.env,
      graceMs: 1000
    },
    mapPath
  )
  assert.equal(plan.executable, WSL.ready.executable)
  assert.deepEqual(plan.args.slice(0, 8), [
    '-d',
    'Phi Ubuntu',
    '--cd',
    '/mnt/d/项目 1',
    '--exec',
    '/usr/bin/env',
    '-i',
    '--'
  ])
  assert.ok(plan.args.includes('/home/phi/runtime/envs/nextflow/bin/python'))
  assert.deepEqual(plan.args.slice(-7, -1), [
    command,
    'run',
    'wrapper/main.nf',
    '-params-file',
    '/mnt/c/Temp/参数.json',
    '-work-dir'
  ])
  assert.match(plan.args.at(-1) ?? '', /^\/home\/phi\/runtime\/nextflow-work\//u)
})

test(
  'Linux supervisor forwards notebook interrupts and terminates on ownership pipe closure',
  {
    skip: process.platform === 'win32' || spawnSync('python3', ['--version']).status !== 0,
    timeout: 5000
  },
  async () => {
    const command = [
      process.execPath,
      '-e',
      `
    process.on('SIGINT', () => console.log('interrupt'));
    process.on('SIGTERM', () => process.exit(0));
    console.log(process.argv[1]);
    setInterval(() => {}, 1000);
  `,
      '\\\\wsl.localhost\\Phi Ubuntu\\home\\phi\\kernel file.json'
    ]
    const child = spawn(
      'python3',
      wslProcessSupervisorArgs(command, {
        graceMs: 1000,
        distro: WSL.ready.distro,
        connectionIndex: 3
      })
    )
    const closed = once(child, 'close')
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    try {
      assert.equal((await lines.next()).value, '/home/phi/kernel file.json')
      child.stdin.write('INT\n')
      assert.equal((await lines.next()).value, 'interrupt')
      child.stdin.end()
      assert.deepEqual(await closed, [0, null])
    } finally {
      child.stdin.end()
    }
  }
)
