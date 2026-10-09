import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A stand-in Slurm: `sbatch`, `squeue`, `scontrol`, `scancel` and `sacct` executables that put
 * a script through a real `bash` in the background, so a submitted job actually runs (and can
 * really be cancelled). Job state lives in files under `FAKE_SLURM_DIR`. `sacct` always fails,
 * like the clusters where slurmdbd is down, so status must come from `scontrol`.
 *
 * Knobs (environment): FAKE_SLURM_REJECT=<message> makes `sbatch` refuse the job. A test can
 * also write `job-<id>.state` to override the state `scontrol` reports (e.g. TIMEOUT).
 */
const IMPLEMENTATION = String.raw`
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const dir = process.env.FAKE_SLURM_DIR
const [command, ...args] = process.argv.slice(2)
const file = (name) => path.join(dir, name)
const read = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : undefined)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const meta = (id) => { const raw = read('job-' + id + '.json'); return raw ? JSON.parse(raw) : undefined }
const option = (flag) => {
  const inline = args.find((arg) => arg.startsWith(flag + '='))
  if (inline) return inline.slice(flag.length + 1)
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function state(id) {
  const job = meta(id)
  if (!job) return undefined
  const override = read('job-' + id + '.state')
  const exit = read('job-' + id + '.exit')
  if (override) return { state: override.trim(), code: exit === undefined ? 1 : Number(exit) }
  if (exit !== undefined && fs.existsSync(file('job-' + id + '.term-signalled'))) {
    return { state: 'CANCELLED', code: Number(exit) }
  }
  if (exit !== undefined) return { state: Number(exit) === 0 ? 'COMPLETED' : 'FAILED', code: Number(exit) }
  if (alive(job.pid)) return { state: 'RUNNING', code: 0 }
  const signalled =
    fs.existsSync(file('job-' + id + '.cancelled')) ||
    fs.existsSync(file('job-' + id + '.term-signalled'))
  return { state: signalled ? 'CANCELLED' : 'NODE_FAIL', code: 0 }
}

if (command === 'sbatch') {
  if (process.env.FAKE_SLURM_REJECT) { console.error('sbatch: error: ' + process.env.FAKE_SLURM_REJECT); process.exit(1) }
  const script = args[args.length - 1]
  const text = fs.readFileSync(script, 'utf8')
  const directives = text.split('\n').filter((l) => l.startsWith('#SBATCH ')).map((l) => l.slice(8).trim())
  const value = (flag) => { const d = directives.filter((x) => x.startsWith(flag + '=')).pop(); return d && d.slice(flag.length + 1) }
  const id = String(Number(read('next') || '5000') + 1)
  fs.writeFileSync(file('next'), id)
  const out = option('--output') || value('--output') || '/dev/null'
  const err = option('--error') || value('--error') || '/dev/null'
  const chdir = option('--chdir') || value('--chdir') || process.cwd()
  for (const p of [out, err]) if (p) fs.mkdirSync(path.dirname(p), { recursive: true })
  const exitFile = file('job-' + id + '.exit')
  const shell = 'trap \'code=$?; echo "$code" > "$2"\' EXIT; source "$1"'
  const outFd = fs.openSync(out, 'a'), errFd = fs.openSync(err, 'a')
  const child = spawn('bash', ['-c', shell, script, script, exitFile], {
    cwd: chdir,
    detached: true,
    stdio: ['ignore', outFd, errFd]
  })
  fs.closeSync(outFd); fs.closeSync(errFd)
  child.unref()
  fs.writeFileSync(file('job-' + id + '.json'), JSON.stringify({ pid: child.pid, script, directives, workDir: chdir }))
  console.log('Submitted batch job ' + id)
} else if (command === 'squeue') {
  const jobIndex = args.indexOf('-j')
  if (jobIndex >= 0) {
    const s = state(args[jobIndex + 1])
    if (s && s.state === 'RUNNING') console.log('RUNNING')
  } else {
    const format = option('-o') || '%i'
    if (format.includes('%Z') && read('squeue-workdir-supported') === '0') {
      console.error('squeue: error: Invalid job format specification: Z')
      process.exit(1)
    }
    const ids = fs.readdirSync(dir).map((name) => name.match(/^job-(\d+)\.json$/)?.[1]).filter(Boolean)
    for (const id of ids.sort((a, b) => Number(a) - Number(b))) {
      const s = state(id), job = meta(id)
      if (s?.state !== 'RUNNING') continue
      console.log(format.replaceAll('%i', id).replaceAll('%T', s.state).replaceAll('%Z', job.workDir))
    }
  }
} else if (command === 'scontrol') {
  const id = args[args.length - 1]
  const s = state(id)
  if (!s) process.exit(1)
  const job = meta(id)
  const name = job?.directives.find((directive) => directive.startsWith('--job-name='))?.slice('--job-name='.length) || 'unknown'
  console.log('JobId=' + id + ' JobName=' + name + ' JobState=' + s.state + ' Reason=None ExitCode=' + s.code + ':0 WorkDir=' + job.workDir)
} else if (command === 'scancel') {
  const id = args.filter((a) => !a.startsWith('-')).pop()
  const job = meta(id)
  const requestedSignal = option('--signal') || option('-s')
  const signalName = requestedSignal === 'TERM' ? 'TERM' : 'KILL'
  const signal = 'SIG' + signalName
  fs.appendFileSync(
    file('scancel-calls.jsonl'),
    JSON.stringify({ jobId: id, full: args.includes('--full'), signal: signalName, args }) + '\n'
  )
  if (job && alive(job.pid) && read('job-' + id + '.unkillable') !== '1') {
    const marker = signalName === 'TERM' ? 'term-signalled' : 'cancelled'
    fs.writeFileSync(file('job-' + id + '.' + marker), '1')
    try { process.kill(-job.pid, signal) } catch {}
  }
} else if (command === 'sacct') {
  console.error('sacct: error: slurm_persist_conn_open_without_init: failed to open persistent connection')
  process.exit(1)
} else {
  console.error('fake slurm: unknown command ' + command); process.exit(2)
}
`

export interface FakeSlurmCancelCall {
  jobId: string
  full: boolean
  signal: 'KILL' | 'TERM'
  args: string[]
}

export interface FakeSlurm {
  dir: string
  /** The `#SBATCH` directives of a submitted job, in order. */
  directives: (jobId: string) => string[]
  /** Force the state `scontrol` reports for a job (as the scheduler would after a time limit). */
  setState: (jobId: string, state: string) => void
  /** Job pid, for liveness checks. */
  pid: (jobId: string) => number
  /** Every scancel request received by the fake, in arrival order. */
  scancelCalls: () => FakeSlurmCancelCall[]
  /** Make squeue reject or accept the `%Z` WorkDir format. */
  setSqueueWorkDirSupported: (supported: boolean) => void
  /** Keep a job alive across scancel calls to exercise residual-job reporting. */
  setUnkillable: (jobId: string, unkillable: boolean) => void
  restore: () => void
}

/** Puts the fake Slurm first on PATH under `dir` and points FAKE_SLURM_DIR at its state. */
export function installFakeSlurm(dir: string): FakeSlurm {
  const bin = join(dir, 'bin')
  const state = join(dir, 'state')
  mkdirSync(bin, { recursive: true })
  mkdirSync(state, { recursive: true })
  const impl = join(dir, 'fake-slurm.cjs')
  writeFileSync(impl, IMPLEMENTATION)
  for (const command of ['sbatch', 'squeue', 'scontrol', 'scancel', 'sacct']) {
    const wrapper = join(bin, command)
    writeFileSync(wrapper, `#!/bin/sh\nexec node ${JSON.stringify(impl)} ${command} "$@"\n`)
    chmodSync(wrapper, 0o755)
  }
  const saved = { PATH: process.env.PATH, FAKE_SLURM_DIR: process.env.FAKE_SLURM_DIR }
  process.env.PATH = `${bin}:${saved.PATH ?? ''}`
  process.env.FAKE_SLURM_DIR = state
  const job = (jobId: string): { pid: number; directives: string[] } =>
    JSON.parse(readFileSync(join(state, `job-${jobId}.json`), 'utf-8'))
  return {
    dir,
    directives: (jobId) => job(jobId).directives,
    setState: (jobId, value) => writeFileSync(join(state, `job-${jobId}.state`), value),
    pid: (jobId) => job(jobId).pid,
    scancelCalls: () => {
      const calls = join(state, 'scancel-calls.jsonl')
      if (!existsSync(calls)) return []
      return readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeSlurmCancelCall)
    },
    setSqueueWorkDirSupported: (supported) =>
      writeFileSync(join(state, 'squeue-workdir-supported'), supported ? '1' : '0'),
    setUnkillable: (jobId, unkillable) =>
      writeFileSync(join(state, `job-${jobId}.unkillable`), unkillable ? '1' : '0'),
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
}
