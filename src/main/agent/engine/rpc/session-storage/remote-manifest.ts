import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { shellQuote as q } from '../../../wrappers/remote-ssh-session'
import { remoteJournalPath } from './paths'
import {
  runStorageCommand,
  storageHost,
  storagePrefix,
  waitForStorageOperation
} from './remote-preflight'
import {
  RemoteSessionStorageError,
  type RemoteSessionReference,
  type RemoteSessionServerManifest,
  type RemoteSessionStoragePreparation
} from './types'

const MANIFEST_MAX_BYTES = 16 * 1024
const publications = new WeakMap<RemoteSessionStoragePreparation, Promise<void>>()

const fields = [
  'schemaVersion',
  'kind',
  'version',
  'hostProfileId',
  'bindingHash',
  'projectId',
  'projectRoot',
  'runtimeRoot',
  'phiSessionId',
  'durableSessionKey',
  'ompVersion',
  'ompSessionId',
  'journalBasename'
].sort()

export function validateRemoteSessionManifest(
  preparation: RemoteSessionStoragePreparation,
  candidate: unknown
): Readonly<RemoteSessionServerManifest> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new RemoteSessionStorageError('FILE_INVALID', 'Invalid remote session manifest')
  const manifest = candidate as RemoteSessionServerManifest
  if (
    Object.keys(manifest).sort().join(',') !== fields.join(',') ||
    manifest.schemaVersion !== 1 ||
    Object.entries(manifest).some(([key, value]) =>
      key === 'schemaVersion' || key === 'version' ? value !== 1 : typeof value !== 'string'
    )
  )
    throw new RemoteSessionStorageError('FILE_INVALID', 'Invalid remote session manifest fields')
  remoteJournalPath(preparation.scope, manifest)
  return Object.freeze({ ...manifest })
}

export async function readRemoteSessionManifest(
  preparation: RemoteSessionStoragePreparation,
  signal?: AbortSignal
): Promise<Readonly<RemoteSessionServerManifest> | undefined> {
  const host = storageHost(preparation)
  const { scope, paths, lease } = preparation
  const operationSignal = signal ? AbortSignal.any([lease.signal, signal]) : lease.signal
  const output = await runStorageCommand(
    host,
    scope,
    `${storagePrefix(scope, paths)}
if [ ! -e ${q(paths.manifest)} ] && [ ! -L ${q(paths.manifest)} ]; then
  printf 'PHI_STORAGE_MANIFEST_MISSING';
else
  storage_file ${q(paths.manifest)}
  head -c ${MANIFEST_MAX_BYTES + 1} -- ${q(paths.manifest)} | base64
fi`,
    operationSignal,
    24 * 1024
  )
  lease.assertActive()
  if (output === 'PHI_STORAGE_MANIFEST_MISSING') return undefined
  if (!/^[A-Za-z0-9+/=\s]*$/.test(output))
    throw new RemoteSessionStorageError('FILE_INVALID', 'Invalid remote manifest encoding')
  const bytes = Buffer.from(output.replace(/\s/g, ''), 'base64')
  if (bytes.length > MANIFEST_MAX_BYTES)
    throw new RemoteSessionStorageError('FILE_INVALID', 'Remote manifest exceeds its byte limit')
  let candidate: unknown
  try {
    candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new RemoteSessionStorageError('FILE_INVALID', 'Malformed remote session manifest')
  }
  return validateRemoteSessionManifest(preparation, candidate)
}

/** Serialize adoption checks and publication; cancelled waiters keep their predecessor tail. */
export async function publishRemoteSessionManifest(
  preparation: RemoteSessionStoragePreparation,
  reference: RemoteSessionReference,
  signal?: AbortSignal
): Promise<Readonly<RemoteSessionServerManifest>> {
  const manifest = validateRemoteSessionManifest(preparation, { ...reference, schemaVersion: 1 })
  const content = `${JSON.stringify(manifest)}\n`
  if (Buffer.byteLength(content) > MANIFEST_MAX_BYTES)
    throw new RemoteSessionStorageError('FILE_INVALID', 'Remote manifest exceeds its byte limit')
  const operationSignal = signal
    ? AbortSignal.any([preparation.lease.signal, signal])
    : preparation.lease.signal
  const previous = publications.get(preparation) ?? Promise.resolve()
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const current = previous.then(() => done)
  publications.set(preparation, current)
  void current.then(() => {
    if (publications.get(preparation) === current) publications.delete(preparation)
  })
  const mutations: Promise<unknown>[] = []
  try {
    await waitForStorageOperation(previous, operationSignal)
    operationSignal.throwIfAborted()
    return await publishManifestLocked(preparation, manifest, content, operationSignal, mutations)
  } finally {
    // A caller can retire promptly while the transport settles; its successor cannot
    // publish until the old server mutation actually finishes (or definitively fails).
    void Promise.allSettled(mutations).then(finish)
  }
}

/** Publication is atomic on the server; cancellation after rename has an unknown acknowledgement. */
async function publishManifestLocked(
  preparation: RemoteSessionStoragePreparation,
  manifest: Readonly<RemoteSessionServerManifest>,
  content: string,
  signal: AbortSignal,
  mutations: Promise<unknown>[]
): Promise<Readonly<RemoteSessionServerManifest>> {
  const existing = await readRemoteSessionManifest(preparation, signal)
  if (
    existing &&
    fields.some(
      (key) =>
        existing[key as keyof RemoteSessionServerManifest] !==
        manifest[key as keyof RemoteSessionServerManifest]
    )
  )
    throw new RemoteSessionStorageError(
      'IDENTITY_MISMATCH',
      'Existing durable session cannot be retargeted'
    )
  const host = storageHost(preparation)
  const { scope, paths, lease } = preparation
  const temporary = `${paths.directory}/.manifest-${randomUUID()}.tmp`
  let created = false
  const cleanup = (): Promise<void> =>
    runStorageCommand(
      host,
      scope,
      `${storagePrefix(scope, paths)}
if [ -e ${q(temporary)} ] || [ -L ${q(temporary)} ]; then
  storage_file ${q(temporary)}
  rm -- ${q(temporary)} || storage_fail PERSISTENCE_FAILED
fi`
    )
      .then(() => undefined)
      .catch(() => undefined)
  try {
    lease.assertActive()
    signal.throwIfAborted()
    // This path is a fresh private transaction name; the existing host writer uses exclusive creation.
    const staging = host.fs.writeAtomic(temporary, content, { ifAbsent: true })
    mutations.push(staging)
    void staging.then(
      () => {
        created = true
        if (signal.aborted) void cleanup()
      },
      () => undefined
    )
    await waitForStorageOperation(staging, signal)
    created = true
    lease.assertActive()
    signal.throwIfAborted()
    const commitHost = {
      ...host,
      capabilities: () => host.capabilities(),
      exec: {
        ...host.exec,
        run: (...args: Parameters<typeof host.exec.run>): ReturnType<typeof host.exec.run> => {
          const pending = host.exec.run(...args)
          mutations.push(pending)
          return pending
        }
      }
    }
    await runStorageCommand(
      commitHost,
      scope,
      `${storagePrefix(scope, paths)}
storage_file ${q(temporary)}
if [ -e ${q(paths.manifest)} ] || [ -L ${q(paths.manifest)} ]; then storage_file ${q(paths.manifest)}; fi
mv -f -- ${q(temporary)} ${q(paths.manifest)} || storage_fail PERSISTENCE_FAILED
storage_file ${q(paths.manifest)}`,
      signal
    )
    lease.assertActive()
    signal.throwIfAborted()
    return manifest
  } catch (error) {
    lease.assertActive()
    signal.throwIfAborted()
    if (error instanceof RemoteSessionStorageError) throw error
    throw new RemoteSessionStorageError('PERSISTENCE_FAILED', 'Could not publish remote manifest', {
      cause: error
    })
  } finally {
    // A late staging completion owns its own cleanup; authority never waits for that transport.
    if (created) {
      if (signal.aborted) void cleanup()
      else await cleanup()
    }
  }
}
