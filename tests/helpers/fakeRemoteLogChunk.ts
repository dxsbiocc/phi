import type {
  RemoteFileChunk,
  RemoteFileChunkOptions
} from '../../src/main/agent/wrappers/remote-ssh-log'

export function fakeRemoteLogChunk(
  files: Map<string, string>,
  path: string,
  options: RemoteFileChunkOptions
): RemoteFileChunk {
  const content = files.get(path)
  if (content === undefined) {
    return {
      missing: true,
      bytes: Buffer.alloc(0),
      size: 0,
      startOffset: options.offset,
      nextOffset: options.offset
    }
  }
  const data = Buffer.from(content, 'utf8')
  const identity = '1:1'
  const reset =
    options.identity && options.identity !== identity
      ? ('rotated' as const)
      : options.offset > data.length
        ? ('truncated' as const)
        : undefined
  const startOffset = options.tail
    ? Math.max(0, data.length - options.maxBytes)
    : reset
      ? 0
      : options.offset
  const bytes = data.subarray(startOffset, startOffset + options.maxBytes)
  return {
    missing: false,
    bytes,
    size: data.length,
    identity,
    startOffset,
    nextOffset: startOffset + bytes.length,
    ...(reset ? { reset } : {})
  }
}
