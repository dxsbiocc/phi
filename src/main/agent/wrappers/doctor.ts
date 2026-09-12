import { spawnSync } from 'node:child_process'

export interface DoctorCheckResult {
  id: string
  label: string
  ok: boolean
  detail?: string
}

export interface LocalDoctorReport {
  ok: boolean
  checks: DoctorCheckResult[]
}

function checkBinary(
  id: string,
  label: string,
  binary: string,
  versionArgs: string[]
): DoctorCheckResult {
  try {
    const result = spawnSync(binary, versionArgs, { encoding: 'utf-8', timeout: 5000 })
    if (result.error || result.status !== 0) {
      return { id, label, ok: false, detail: `未找到可执行的 ${label}（${binary}）` }
    }
    const detail = (result.stdout || result.stderr || '').trim().split('\n')[0]
    return { id, label, ok: true, detail }
  } catch {
    return { id, label, ok: false, detail: `未找到可执行的 ${label}（${binary}）` }
  }
}

/**
 * Local-only doctor check (Phase 1 has no remote doctor yet — see
 * docs/design/phi-wrapper-technical-design.md, Executor Model). Checks
 * Nextflow always; checks Docker only when `requireDocker` is set (the
 * chosen profile declares `containerRuntime: docker`).
 */
export function checkLocalDoctor(options: { requireDocker?: boolean } = {}): LocalDoctorReport {
  const checks: DoctorCheckResult[] = [
    checkBinary('nextflow', 'Nextflow', 'nextflow', ['-version'])
  ]
  if (options.requireDocker) {
    checks.push(checkBinary('docker', 'Docker', 'docker', ['--version']))
  }
  return { ok: checks.every((check) => check.ok), checks }
}
