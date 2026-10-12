/**
 * Parser for the smart-HTTP ref advertisement (`info/refs?service=git-upload-pack`, protocol v0/v1).
 *
 * GitHub serves it anonymously and it is not counted against the 60-per-hour REST API quota,
 * so it is the preferred way to turn a branch, tag or HEAD into a commit sha. Pure and
 * bounded: it never touches the network or the file system.
 */

const MAX_PACKETS = 50_000
const SHA = /^[a-f0-9]{40}$/

export interface GitRefAdvertisement {
  /** The sha HEAD points at, when the server advertised it. */
  head: string | undefined
  /**
   * Resolve a branch, tag or `HEAD` (undefined means HEAD). Annotated tags resolve to the
   * commit they peel to. Returns undefined when the ref is not advertised.
   */
  resolve(ref: string | undefined): string | undefined
}

export function parseGitRefAdvertisement(bytes: Buffer): GitRefAdvertisement {
  const refs = new Map<string, string>()
  let offset = 0
  let packets = 0
  let sawService = false
  while (offset < bytes.length) {
    if (++packets > MAX_PACKETS) throw invalid('引用数量超过限制')
    const header = bytes.subarray(offset, offset + 4).toString('ascii')
    if (!/^[0-9a-f]{4}$/.test(header)) throw invalid('数据包长度无效')
    const length = Number.parseInt(header, 16)
    if (length === 0) {
      offset += 4
      continue
    }
    if (length < 4 || offset + length > bytes.length) throw invalid('数据包长度无效')
    const payload = bytes
      .subarray(offset + 4, offset + length)
      .toString('utf8')
      .replace(/\n$/, '')
    offset += length

    if (payload.startsWith('# service=')) {
      sawService = true
      continue
    }
    if (!sawService) throw invalid('缺少服务声明')
    const [line] = payload.split('\0')
    const separator = line?.indexOf(' ') ?? -1
    if (!line || separator !== 40) throw invalid('引用行格式无效')
    const sha = line.slice(0, 40)
    const name = line.slice(41)
    if (!SHA.test(sha) || !name) throw invalid('引用行格式无效')
    refs.set(name, sha)
  }
  if (!sawService) throw invalid('缺少服务声明')

  const head = refs.get('HEAD')
  return {
    head,
    resolve(ref) {
      if (ref === undefined || ref === 'HEAD') return head
      // A branch wins, then the commit an annotated tag points at, then a lightweight tag.
      return (
        refs.get(`refs/heads/${ref}`) ??
        refs.get(`refs/tags/${ref}^{}`) ??
        refs.get(`refs/tags/${ref}`)
      )
    }
  }
}

function invalid(reason: string): Error {
  return new Error(`GitHub 引用列表无效：${reason}`)
}
