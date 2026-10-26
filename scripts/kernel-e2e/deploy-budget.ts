import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Slowest link the SSH scenarios must tolerate (VPN to the lab cluster has dropped to ~0.5 MB/s). */
export const MIN_DEPLOY_BYTES_PER_SECOND = 0.2 * 1024 * 1024
/** Probe, verification, activation and kernel start on top of the raw upload. */
const DEPLOY_OVERHEAD_MS = 3 * 60_000
/** Scenario steps after deployment keep their own per-step bounds; this is their share of the run. */
const POST_DEPLOY_MS = 15 * 60_000

interface ManifestFile {
  readonly role?: unknown
  readonly size?: unknown
}

/** Bytes a fresh deployment uploads: the kernel plus the largest native variant. */
export function deployUploadBytes(manifest: { readonly files?: readonly ManifestFile[] }): number {
  const files = manifest.files ?? []
  const size = (file: ManifestFile): number =>
    typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0 ? file.size : 0
  const kernel = files.filter((file) => file.role === 'kernel').reduce((sum, f) => sum + size(f), 0)
  const native = Math.max(0, ...files.filter((file) => file.role === 'native').map(size))
  if (kernel === 0) throw new Error('Kernel build manifest lists no kernel artifact size')
  return kernel + native
}

export function deployTimeoutMs(uploadBytes: number): number {
  return Math.ceil((uploadBytes / MIN_DEPLOY_BYTES_PER_SECOND) * 1000) + DEPLOY_OVERHEAD_MS
}

/** The overall deadline never cuts a deployment that is still within its size-based budget. */
export function effectiveDeadlineMinutes(requested: number, deployMs: number): number {
  return Math.max(requested, Math.ceil((deployMs + POST_DEPLOY_MS) / 60_000))
}

export function readDeployBudget(buildDirectory: string): {
  readonly uploadBytes: number
  readonly deployTimeoutMs: number
} {
  const manifest = JSON.parse(readFileSync(join(buildDirectory, 'manifest.json'), 'utf8')) as {
    files?: ManifestFile[]
  }
  const uploadBytes = deployUploadBytes(manifest)
  return { uploadBytes, deployTimeoutMs: deployTimeoutMs(uploadBytes) }
}
