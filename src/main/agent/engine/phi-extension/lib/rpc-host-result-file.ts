import { createHash } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync
} from 'node:fs'
import { posix } from 'node:path'
import {
  MAX_HOST_RESULT_FILE_BYTES,
  encodeHostResultEnvelope,
  hostResultLookupId,
  parseHostResultReceipt,
  encodeHostResult,
  validHostResultPayload,
  type HostResultPayload,
  type HostResultLookupIdentity
} from './rpc-host-result-protocol'

/** All ancestors from the trusted generation down are owned 700 real directories. */
function privateDirectories(
  generationDirectory: string,
  directory: string
): Array<{ path: string; dev: number; ino: number }> {
  if (
    !generationDirectory.startsWith('/') ||
    posix.normalize(generationDirectory) !== generationDirectory ||
    realpathSync(generationDirectory) !== generationDirectory ||
    !directory.startsWith(`${generationDirectory}/host-results-`) ||
    posix.dirname(directory) !== generationDirectory ||
    !/^host-results-[a-f0-9]{64}$/.test(posix.basename(directory))
  )
    throw new Error('Invalid private result directory')
  return [generationDirectory, directory].map((path) => {
    const info = lstatSync(path)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o700 ||
      realpathSync(path) !== path
    )
      throw new Error('Host result directory is not private')
    return { path, dev: info.dev, ino: info.ino }
  })
}
export function consumeHostResultFile(
  generationDirectory: string,
  directory: string,
  identity: HostResultLookupIdentity,
  capability: string,
  signal: AbortSignal
): HostResultPayload {
  signal.throwIfAborted()
  const directories = privateDirectories(generationDirectory, directory)
  const lookup = hostResultLookupId(identity, capability)
  const path = posix.join(directory, `${lookup}.json`)
  let fd: number | undefined
  let owned = false
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    const named = lstatSync(path)
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size < 2 ||
      info.size > MAX_HOST_RESULT_FILE_BYTES ||
      named.dev !== info.dev ||
      named.ino !== info.ino ||
      named.isSymbolicLink()
    )
      throw new Error('Invalid private host result file')
    owned = true
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) break
      offset += count
    }
    const after = fstatSync(fd)
    if (
      offset !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs ||
      after.nlink !== 1
    )
      throw new Error('Host result hash/size mismatch')
    for (const ancestor of directories) {
      const current = lstatSync(ancestor.path)
      if (
        current.ino !== ancestor.ino ||
        current.dev !== ancestor.dev ||
        current.isSymbolicLink() ||
        (current.mode & 0o7777) !== 0o700 ||
        realpathSync(ancestor.path) !== ancestor.path
      )
        throw new Error('Host result directory changed')
    }
    const finalName = lstatSync(path)
    if (finalName.dev !== info.dev || finalName.ino !== info.ino || finalName.isSymbolicLink())
      throw new Error('Host result file changed')
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
    const envelope: unknown = JSON.parse(json)
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      Object.keys(envelope).length !== 2 ||
      !Object.hasOwn(envelope, 'receipt') ||
      !Object.hasOwn(envelope, 'result')
    )
      throw new Error('Invalid private host result envelope')
    const { receipt: rawReceipt, result } = envelope as { receipt: unknown; result: unknown }
    const receipt = parseHostResultReceipt(rawReceipt, capability)
    if (
      !receipt ||
      receipt.receiptId !== lookup ||
      !(
        [
          'leaseId',
          'generation',
          'phiSessionId',
          'projectId',
          'cwd',
          'runId',
          'toolCallId',
          'toolName',
          'progressSequence'
        ] as const
      ).every((field) => receipt[field] === identity[field])
    )
      throw new Error('Private host result receipt scope mismatch')
    if (!validHostResultPayload(result)) throw new Error('Invalid host result schema')
    const payload = encodeHostResult(result)
    if (
      payload.length !== receipt.bytes ||
      createHash('sha256').update(payload).digest('hex') !== receipt.sha256 ||
      !bytes.subarray(0, offset).equals(encodeHostResultEnvelope(receipt, payload))
    )
      throw new Error('Host result envelope hash/size mismatch')
    signal.throwIfAborted()
    unlinkSync(path)
    owned = false
    return result
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (owned) {
      try {
        unlinkSync(path)
      } catch {
        /* Generation cleanup also reclaims failed receipts. */
      }
    }
  }
}
