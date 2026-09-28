import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildRemoteLaunchScript,
  buildRemoteConfiguredLaunchScript,
  buildRemotePreflightScript,
  buildRemoteSbatchScript,
  buildRemoteNextflowConfig,
  remoteRunLayout
} from '../src/main/agent/wrappers/composition/remote-config'
import { controllerFor } from '../src/main/agent/wrappers/composition/remote-controller'

test('slurm settings become process and executor config', () => {
  const config = buildRemoteNextflowConfig({
    scheduler: 'slurm',
    queue: 'cpu',
    account: 'lab1',
    clusterOptions: '--qos=normal',
    queueSize: 20,
    singularityCacheDir: '/shared/sif'
  })
  assert.match(config, /process\.executor = 'slurm'/)
  assert.match(config, /process\.queue = 'cpu'/)
  assert.match(config, /process\.clusterOptions = '--account=lab1 --qos=normal'/)
  assert.match(config, /executor\.queueSize = 20/)
  assert.match(config, /singularity\.cacheDir = '\/shared\/sif'/)
})

test('the local scheduler keeps processes on the host and omits slurm-only settings', () => {
  const config = buildRemoteNextflowConfig({
    scheduler: 'local',
    queue: 'ignored',
    account: 'ignored'
  })
  assert.match(config, /process\.executor = 'local'/)
  assert.doesNotMatch(config, /queue|account|clusterOptions/)
})

test('config values are escaped so they cannot break out of a Groovy string', () => {
  const config = buildRemoteNextflowConfig({
    scheduler: 'slurm',
    queue: "a'b\\c",
    singularityCacheDir: "/x/it's"
  })
  assert.match(config, /process\.queue = 'a\\'b\\\\c'/)
  assert.match(config, /singularity\.cacheDir = '\/x\/it\\'s'/)
})

test('remoteRunLayout keeps runs and bundles under the workspace root, with posix paths', () => {
  const layout = remoteRunLayout({
    workspaceRoot: '/data/lab/.phi',
    runId: 'wrun_1',
    bundleHash: 'abc123',
    componentRelPath: 'modules/nf-core/fastqc'
  })
  assert.equal(layout.runDir, '/data/lab/.phi/wrappers/runs/wrun_1')
  assert.equal(layout.bundleDir, '/data/lab/.phi/wrappers/bundles/abc123')
  assert.equal(layout.componentDir, '/data/lab/.phi/wrappers/bundles/abc123/modules/nf-core/fastqc')
  assert.equal(layout.paramsFile, '/data/lab/.phi/wrappers/runs/wrun_1/params.json')
  assert.equal(layout.configFile, '/data/lab/.phi/wrappers/runs/wrun_1/phi_remote.config')
  assert.equal(layout.outDir, '/data/lab/.phi/wrappers/runs/wrun_1/results')
})

test('remoteRunLayout tolerates a trailing slash on the workspace root', () => {
  const layout = remoteRunLayout({
    workspaceRoot: '/data/lab/.phi/',
    runId: 'r',
    bundleHash: 'h',
    componentRelPath: 'modules/x'
  })
  assert.equal(layout.runDir, '/data/lab/.phi/wrappers/runs/r')
})

const LAYOUT = remoteRunLayout({
  workspaceRoot: '/w',
  runId: 'r1',
  bundleHash: 'h1',
  componentRelPath: 'modules/nf-core/fastqc'
})

test('launch script runs nextflow from the component dir with the run files and profile', () => {
  const script = buildRemoteLaunchScript({ layout: LAYOUT, profile: 'singularity', hpc: undefined })
  assert.match(script, /cd '\/w\/wrappers\/bundles\/h1\/modules\/nf-core\/fastqc'/)
  assert.match(script, /'nextflow' 'run' 'wrapper\/main\.nf'/)
  assert.match(script, /'-params-file' '\/w\/wrappers\/runs\/r1\/params\.json'/)
  assert.match(script, /'-profile' 'singularity'/)
  assert.match(script, /'-c' '\/w\/wrappers\/runs\/r1\/phi_remote\.config'/)
  assert.match(script, /'-w' '\/w\/wrappers\/runs\/r1\/work'/)
  assert.match(script, /echo "\$rc" > 'exit_code'/)
})

test('launch script skips the launcher version check that stalls on slow or offline hosts', () => {
  const script = buildRemoteLaunchScript({ layout: LAYOUT, profile: 'docker', hpc: undefined })
  const check = script.indexOf('export NXF_DISABLE_CHECK_LATEST=true')
  assert.ok(check >= 0)
  assert.ok(check < script.indexOf("'nextflow' 'run'"))
})

test('launch script runs setup commands first and honors an explicit nextflow path', () => {
  const script = buildRemoteLaunchScript({
    layout: LAYOUT,
    profile: 'conda',
    hpc: {
      scheduler: 'slurm',
      nextflowBin: '/opt/nf/bin/nextflow',
      setupCommands: ['module load java', '']
    }
  })
  assert.ok(script.indexOf('module load java') < script.indexOf('nextflow'))
  assert.match(script, /'\/opt\/nf\/bin\/nextflow' 'run'/)
})

test('shared remote launch runs setup in the head process and records setup failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-shared-launch-'))
  try {
    const file = join(dir, 'launch.sh')
    writeFileSync(
      file,
      buildRemoteConfiguredLaunchScript({
        runDir: dir,
        setupCommands: ['echo SETUP >> setup.marker', 'false'],
        commands: ['echo MUST_NOT_RUN >> setup.marker']
      })
    )
    assert.throws(() => execFileSync('bash', [file], { cwd: dir, stdio: 'ignore' }))
    assert.equal(readFileSync(join(dir, 'setup.marker'), 'utf8'), 'SETUP\n')
    assert.equal(readFileSync(join(dir, 'exit_code'), 'utf8').trim(), '1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing setup command stops the launch and is recorded as the exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-launch-'))
  try {
    const layout = remoteRunLayout({
      workspaceRoot: dir,
      runId: 'r',
      bundleHash: 'h',
      componentRelPath: 'c'
    })
    const script = buildRemoteLaunchScript({
      layout: { ...layout, runDir: dir },
      profile: 'docker',
      hpc: { scheduler: 'local', setupCommands: ['false'] }
    })
    const file = join(dir, 'launch.sh')
    writeFileSync(file, script)
    // the script now exits with the failing code too, which execFileSync reports as a throw
    assert.throws(() => execFileSync('bash', [file], { cwd: dir, stdio: 'ignore' }))
    const exit = execFileSync('cat', [join(dir, 'exit_code')])
      .toString()
      .trim()
    assert.notEqual(exit, '0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the launch script loads the login profile first so `module load` works in a batch shell', () => {
  const script = buildRemoteLaunchScript({
    layout: LAYOUT,
    profile: 'singularity',
    hpc: { scheduler: 'slurm', setupCommands: ['module load nextflow'] }
  })
  const profileAt = script.indexOf('/etc/profile')
  assert.ok(profileAt > 0, 'sources /etc/profile')
  assert.ok(script.indexOf('.bash_profile') > 0, 'sources the user profile')
  assert.ok(profileAt < script.indexOf('set -e'), 'profile is sourced before errexit is on')
  assert.ok(profileAt < script.indexOf('module load nextflow'))
})

function runPreflight(
  hpc: Parameters<typeof buildRemotePreflightScript>[0]['hpc'],
  env: NodeJS.ProcessEnv = {},
  workspaceRoot?: string
): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'phi-preflight-'))
  try {
    const file = join(dir, 'preflight.sh')
    writeFileSync(file, buildRemotePreflightScript({ hpc, profile: 'singularity', workspaceRoot }))
    try {
      const stdout = execFileSync('bash', [file], {
        env: { PATH: '/usr/bin:/bin', HOME: dir, ...env },
        stdio: ['ignore', 'pipe', 'pipe']
      }).toString()
      return { code: 0, stdout, stderr: '' }
    } catch (error) {
      const failed = error as { status: number; stdout: Buffer; stderr: Buffer }
      return {
        code: failed.status,
        stdout: failed.stdout.toString(),
        stderr: failed.stderr.toString()
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('preflight fails, naming the setting to fix, when nextflow is not there', () => {
  const result = runPreflight({ scheduler: 'local', nextflowBin: '/nowhere/nextflow' })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /nextflow/i)
  assert.match(result.stderr, /Nextflow 路径|setup|PATH/i)
})

test('preflight fails when slurm is chosen but sbatch is missing', () => {
  const result = runPreflight({ scheduler: 'slurm', nextflowBin: '/bin/sh' })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /sbatch/)
})

test('preflight warns about a runtime missing on the Slurm login node', () => {
  const result = runPreflight({
    scheduler: 'slurm',
    runtime: 'singularity',
    nextflowBin: '/bin/sh',
    setupCommands: ['sbatch() { :; }', 'squeue() { :; }', 'scontrol() { :; }', 'scancel() { :; }']
  })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /WARN.*(singularity|apptainer)/i)
})

test('preflight runs setup commands first so a module can supply the local runtime', () => {
  const result = runPreflight({
    scheduler: 'local',
    runtime: 'singularity',
    nextflowBin: '/bin/sh',
    setupCommands: ['echo SETUP-RAN', 'singularity() { :; }']
  })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /SETUP-RAN/)
})

test('preflight blocks a server work directory without write permission', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-readonly-workspace-'))
  chmodSync(root, 0o500)
  try {
    const result = runPreflight(
      { scheduler: 'local', nextflowBin: '/bin/sh', setupCommands: ['singularity() { :; }'] },
      {},
      root
    )
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /工作目录.*权限/)
  } finally {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a site requiring sbatch cannot silently launch the head process on the login node', () => {
  assert.throws(
    () => controllerFor({ scheduler: 'local', controller: 'sbatch' }),
    /必须使用 Slurm 调度/
  )
  assert.ok(controllerFor({ scheduler: 'slurm', controller: 'sbatch' }))
})

test('sbatch preflight warns about compute-only tools without running setup on login', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-sbatch-preflight-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  try {
    for (const command of ['sbatch', 'squeue', 'scontrol', 'scancel']) {
      const file = join(bin, command)
      writeFileSync(file, '#!/bin/sh\nexit 0\n')
      chmodSync(file, 0o755)
    }
    const result = runPreflight(
      {
        scheduler: 'slurm',
        controller: 'sbatch',
        nextflowBin: '/not-on-login/nextflow',
        setupCommands: ['false']
      },
      { PATH: `${bin}:/bin` },
      root
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /WARN.*Nextflow/)
    assert.match(result.stdout, /WARN.*singularity/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the launch script exits with Nextflow's own code, so a scheduler sees a failed run as failed", () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-launch-'))
  try {
    const layout = {
      ...remoteRunLayout({
        workspaceRoot: dir,
        runId: 'r',
        bundleHash: 'h',
        componentRelPath: 'c'
      }),
      runDir: dir
    }
    const script = buildRemoteLaunchScript({
      layout,
      profile: 'docker',
      hpc: { scheduler: 'local', setupCommands: ['exit 7'] }
    })
    const file = join(dir, 'launch.sh')
    writeFileSync(file, script)
    let status = 0
    try {
      execFileSync('bash', [file], { cwd: dir, stdio: 'ignore' })
    } catch (error) {
      status = (error as { status: number }).status
    }
    assert.equal(status, 7)
    assert.equal(
      execFileSync('cat', [join(dir, 'exit_code')])
        .toString()
        .trim(),
      '7'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function directives(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => line.startsWith('#SBATCH '))
    .map((line) => line.slice('#SBATCH '.length))
}

test('the sbatch script names the job, pins its directory and sends logs where Phi reads them', () => {
  const script = buildRemoteSbatchScript({
    layout: LAYOUT,
    runId: 'wrun_ab-1',
    hpc: { scheduler: 'slurm' }
  })
  const lines = directives(script)
  assert.ok(script.startsWith('#!/bin/bash\n'))
  assert.ok(lines.includes('--job-name=phi-wrun_ab-1'))
  assert.ok(lines.includes('--chdir=/w/wrappers/runs/r1'))
  assert.ok(lines.includes('--output=/w/wrappers/runs/r1/logs/stdout.log'))
  assert.ok(lines.includes('--error=/w/wrappers/runs/r1/logs/stderr.log'))
  assert.match(script, /\nbash launch\.sh\n$/)
})

test('a slurm head job gets a modest allocation and a long time limit by default', () => {
  const lines = directives(
    buildRemoteSbatchScript({ layout: LAYOUT, runId: 'r', hpc: { scheduler: 'slurm' } })
  )
  assert.ok(lines.includes('--cpus-per-task=1'))
  assert.ok(lines.includes('--mem=4G'))
  assert.ok(
    lines.includes('--time=2-00:00:00'),
    'the partition default is often far shorter than a pipeline'
  )
})

test('the head job uses the connection queue and account, and the local scheduler gets no size defaults', () => {
  const slurm = directives(
    buildRemoteSbatchScript({
      layout: LAYOUT,
      runId: 'r',
      hpc: { scheduler: 'slurm', queue: 'cpu', account: 'lab1' }
    })
  )
  assert.ok(slurm.includes('--partition=cpu'))
  assert.ok(slurm.includes('--account=lab1'))
  const local = directives(
    buildRemoteSbatchScript({ layout: LAYOUT, runId: 'r', hpc: { scheduler: 'local' } })
  )
  assert.ok(!local.some((line) => line.startsWith('--cpus-per-task') || line.startsWith('--mem')))
})

test('controller options come last, one directive per flag, so they override the defaults', () => {
  const lines = directives(
    buildRemoteSbatchScript({
      layout: LAYOUT,
      runId: 'r',
      hpc: { scheduler: 'slurm', controllerOptions: '--time=7-00:00:00  --qos=long' }
    })
  )
  assert.deepEqual(lines.slice(-2), ['--time=7-00:00:00', '--qos=long'])
  assert.ok(lines.indexOf('--time=7-00:00:00') > lines.indexOf('--time=2-00:00:00'))
})

test('a flag that could smuggle in a new script line is refused', () => {
  const script = buildRemoteSbatchScript({
    layout: LAYOUT,
    runId: 'r',
    hpc: { scheduler: 'slurm', controllerOptions: '--qos=long\nrm -rf ~' }
  })
  assert.doesNotMatch(script, /^rm -rf/m)
})

test('preflight needs sbatch when the head process is a Slurm job, even for the local scheduler', () => {
  const result = runPreflight({ scheduler: 'local', controller: 'sbatch', nextflowBin: '/bin/sh' })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /sbatch/)
})
