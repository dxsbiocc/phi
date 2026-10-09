import { createHmac, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'

import type {
  SshBootstrapPublicErrorCode,
  SshBootstrapTarget,
  SshHostKeyFingerprint
} from '../../../shared/sshBootstrapTypes'
import { validateSshBootstrapTarget, type SshBootstrapCommandRunner } from './preflight'

export interface SshHostKeyFileSystem {
  readText(path: string): Promise<string | null>
  ensureDirectory(path: string, mode: number): Promise<void>
  appendText(path: string, content: string, mode: number): Promise<void>
}

export type SshHostKeyInspection =
  | { status: 'ready'; fingerprints: SshHostKeyFingerprint[] }
  | {
      status: 'confirmation-required'
      confirmationId: string
      fingerprints: SshHostKeyFingerprint[]
    }
  | {
      status: 'rejected'
      errorCode: Extract<SshBootstrapPublicErrorCode, 'host_key_changed' | 'unexpected'>
    }

export type SshHostKeyConfirmation =
  | { status: 'ready'; fingerprints: SshHostKeyFingerprint[] }
  | {
      status: 'rejected'
      errorCode: Extract<SshBootstrapPublicErrorCode, 'host_key_changed' | 'unexpected'>
    }

export interface SshHostKeyTrustService {
  inspectTarget(target: SshBootstrapTarget): Promise<SshHostKeyInspection>
  confirmHostKey(confirmationId: string): Promise<SshHostKeyConfirmation>
}

interface SshHostKeyTrustDependencies {
  runCommand: SshBootstrapCommandRunner
  files: SshHostKeyFileSystem
  knownHostsPath: string
  createId: () => string
}

interface ScannedHostKey {
  algorithm: string
  encodedKey: string
}

interface PendingHostKeyConfirmation {
  target: SshBootstrapTarget
  keys: ScannedHostKey[]
  fingerprints: SshHostKeyFingerprint[]
}

const HOST_KEY_ALGORITHMS = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'])

function validatedTarget(target: SshBootstrapTarget): SshBootstrapTarget {
  return validateSshBootstrapTarget(target)
}

function parseKeyLines(output: string): ScannedHostKey[] {
  const unique = new Map<string, ScannedHostKey>()
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const fields = trimmed.split(/\s+/)
    const algorithm = fields[1]
    const encodedKey = fields[2]
    if (!HOST_KEY_ALGORITHMS.has(algorithm) || !encodedKey) continue
    unique.set(`${algorithm}\0${encodedKey}`, { algorithm, encodedKey })
  }
  return [...unique.values()]
}

function lookupHost(target: SshBootstrapTarget): string {
  return target.port === 22 ? target.hostname : `[${target.hostname}]:${target.port}`
}

function hashedHostMatches(pattern: string, host: string): boolean {
  const fields = pattern.split('|')
  if (fields.length !== 4 || fields[0] !== '' || fields[1] !== '1') return false
  try {
    const salt = Buffer.from(fields[2], 'base64')
    const actual = Buffer.from(fields[3], 'base64')
    const expected = createHmac('sha1', salt).update(host).digest()
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function hostFieldMatches(hostField: string, host: string): boolean {
  if (hostField.startsWith('|')) return hashedHostMatches(hostField, host)
  return hostField.split(',').includes(host)
}

function matchingKnownHostKeys(knownHosts: string, target: SshBootstrapTarget): ScannedHostKey[] {
  const host = lookupHost(target)
  const keys: ScannedHostKey[] = []
  for (const line of knownHosts.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const fields = trimmed.split(/\s+/)
    const offset = fields[0].startsWith('@') ? 1 : 0
    const hostField = fields[offset]
    const algorithm = fields[offset + 1]
    const encodedKey = fields[offset + 2]
    if (!hostField || !hostFieldMatches(hostField, host)) continue
    if (!HOST_KEY_ALGORITHMS.has(algorithm) || !encodedKey) continue
    keys.push({ algorithm, encodedKey })
  }
  return keys
}

function keysMatch(existing: ScannedHostKey[], scanned: ScannedHostKey[]): boolean {
  const scannedKeys = new Set(scanned.map((key) => `${key.algorithm}\0${key.encodedKey}`))
  return existing.every((key) => scannedKeys.has(`${key.algorithm}\0${key.encodedKey}`))
}

async function fingerprintsForKeys(
  keys: ScannedHostKey[],
  runCommand: SshBootstrapCommandRunner
): Promise<SshHostKeyFingerprint[] | null> {
  const input = keys.map((key) => `host ${key.algorithm} ${key.encodedKey}`).join('\n') + '\n'
  const result = await runCommand({
    command: 'ssh-keygen',
    args: ['-lf', '-', '-E', 'sha256'],
    stdin: input
  })
  if (result.exitCode !== 0) return null
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length !== keys.length) return null
  const fingerprints: SshHostKeyFingerprint[] = []
  for (let index = 0; index < keys.length; index += 1) {
    const sha256 = /^\d+\s+(SHA256:[^\s]+)/.exec(lines[index])?.[1]
    if (!sha256) return null
    fingerprints.push({ algorithm: keys[index].algorithm, sha256 })
  }
  return fingerprints
}

export function createSshHostKeyTrustService(
  dependencies: SshHostKeyTrustDependencies
): SshHostKeyTrustService {
  const pending = new Map<string, PendingHostKeyConfirmation>()

  return {
    async inspectTarget(input) {
      const target = validatedTarget(input)
      const scan = await dependencies.runCommand({
        command: 'ssh-keyscan',
        args: ['-T', '10', '-p', String(target.port), '-t', 'ed25519,ecdsa,rsa', target.hostname]
      })
      const keys = scan.exitCode === 0 ? parseKeyLines(scan.stdout) : []
      if (keys.length === 0) return { status: 'rejected', errorCode: 'unexpected' }
      const fingerprints = await fingerprintsForKeys(keys, dependencies.runCommand)
      if (!fingerprints) return { status: 'rejected', errorCode: 'unexpected' }

      const knownHosts = (await dependencies.files.readText(dependencies.knownHostsPath)) ?? ''
      const existing = matchingKnownHostKeys(knownHosts, target)
      if (existing.length > 0) {
        return keysMatch(existing, keys)
          ? { status: 'ready', fingerprints }
          : { status: 'rejected', errorCode: 'host_key_changed' }
      }

      const confirmationId = dependencies.createId()
      pending.set(confirmationId, { target, keys, fingerprints })
      return { status: 'confirmation-required', confirmationId, fingerprints }
    },
    async confirmHostKey(confirmationId) {
      const candidate = pending.get(confirmationId)
      if (!candidate) {
        return { status: 'rejected', errorCode: 'unexpected' }
      }
      pending.delete(confirmationId)

      try {
        const knownHosts = (await dependencies.files.readText(dependencies.knownHostsPath)) ?? ''
        const existing = matchingKnownHostKeys(knownHosts, candidate.target)
        if (existing.length > 0) {
          return keysMatch(existing, candidate.keys)
            ? { status: 'ready', fingerprints: candidate.fingerprints }
            : { status: 'rejected', errorCode: 'host_key_changed' }
        }

        const host = lookupHost(candidate.target)
        const lines = candidate.keys
          .map((key) => `${host} ${key.algorithm} ${key.encodedKey}`)
          .join('\n')
        const separator = knownHosts && !knownHosts.endsWith('\n') ? '\n' : ''
        await dependencies.files.ensureDirectory(dirname(dependencies.knownHostsPath), 0o700)
        await dependencies.files.appendText(
          dependencies.knownHostsPath,
          `${separator}${lines}\n`,
          0o600
        )
        return { status: 'ready', fingerprints: candidate.fingerprints }
      } catch {
        return { status: 'rejected', errorCode: 'unexpected' }
      }
    }
  }
}
