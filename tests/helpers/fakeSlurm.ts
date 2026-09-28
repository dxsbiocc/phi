import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

function state(id) {
  const job = meta(id)
  if (!job) return undefined
  const override = read('job-' + id + '.state')
  const exit = read('job-' + id + '.exit')
  if (override) return { state: override.trim(), code: exit === undefined ? 1 : Number(exit) }
  if (exit !== undefined) return { state: Number(exit) === 0 ? 'COMPLETED' : 'FAILED', code: Number(exit) }
  if (alive(job.pid)) return { state: 'RUNNING', code: 0 }
  return { state: fs.existsSync(file('job-' + id + '.cancelled')) ? 'CANCELLED' : 'NODE_FAIL', code: 0 }
}

if (command === 'sbatch') {
  if (process.env.FAKE_SLURM_REJECT) { console.error('sbatch: error: ' + process.env.FAKE_SLURM_REJECT); process.exit(1) }
  const script = args.find((a) => !a.startsWith('-'))
  const text = fs.readFileSync(script, 'utf8')
  const directives = text.split('\n').filter((l) => l.startsWith('#SBATCH ')).map((l) => l.slice(8).trim())
  const value = (flag) => { const d = directives.filter((x) => x.startsWith(flag + '=')).pop(); return d && d.slice(flag.length + 1) }
  const id = String(Number(read('next') || '5000') + 1)
  fs.writeFileSync(file('next'), id)
  const out = value('--output'), err = value('--error'), chdir = value('--chdir') || process.cwd()
  for (const p of [out, err]) if (p) fs.mkdirSync(path.dirname(p), { recursive: true })
  const exitFile = file('job-' + id + '.exit')
  const shell = 'cd "' + chdir + '" && bash "' + script + '" > "' + out + '" 2> "' + err + '"; echo $? > "' + exitFile + '"'
  const child = spawn('bash', ['-c', shell], { detached: true, stdio: 'ignore' })
  child.unref()
  fs.writeFileSync(file('job-' + id + '.json'), JSON.stringify({ pid: child.pid, script, directives }))
  console.log('Submitted batch job ' + id)
} else if (command === 'squeue') {
  const id = args[args.indexOf('-j') + 1]
  const s = state(id)
  if (s && s.state === 'RUNNING') console.log('RUNNING')
} else if (command === 'scontrol') {
  const id = args[args.length - 1]
  const s = state(id)
  if (!s) process.exit(1)
  const job = meta(id)
  const name = job?.directives.find((directive) => directive.startsWith('--job-name='))?.slice('--job-name='.length) || 'unknown'
  console.log('JobId=' + id + ' JobName=' + name + ' JobState=' + s.state + ' Reason=None ExitCode=' + s.code + ':0')
} else if (command === 'scancel') {
  const id = args.filter((a) => !a.startsWith('-')).pop()
  const job = meta(id)
  const signal = args.includes('--signal=KILL') ? 'SIGKILL' : 'SIGTERM'
  if (job && alive(job.pid)) {
    fs.writeFileSync(file('job-' + id + '.cancelled'), '1')
    try { process.kill(-job.pid, signal) } catch {}
  }
} else if (command === 'sacct') {
  console.error('sacct: error: slurm_persist_conn_open_without_init: failed to open persistent connection')
  process.exit(1)
} else {
  console.error('fake slurm: unknown command ' + command); process.exit(2)
}
`

export interface FakeSlurm {
  dir: string
  /** The `#SBATCH` directives of a submitted job, in order. */
  directives: (jobId: string) => string[]
  /** Force the state `scontrol` reports for a job (as the scheduler would after a time limit). */
  setState: (jobId: string, state: string) => void
  /** Job pid, for liveness checks. */
  pid: (jobId: string) => number
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
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
}
