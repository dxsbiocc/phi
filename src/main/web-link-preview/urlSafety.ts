import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type PublicAddress = { address: string; family: 4 | 6 }
export type ResolveAddresses = (hostname: string) => Promise<readonly PublicAddress[]>

export function checkedPreviewUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value || value.length > 16_384 || value !== value.trim()) {
    throw new Error('Invalid web preview address')
  }
  const url = new URL(value)
  const hostname = url.hostname
    .replace(/^\[|\]$/gu, '')
    .toLowerCase()
    .replace(/\.$/u, '')
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !hostname ||
    (!isIP(hostname) &&
      (!hostname.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/u.test(hostname))) ||
    (isIP(hostname) && !isPublicAddress(hostname))
  ) {
    throw new Error('Web preview requires a public HTTP(S) address')
  }
  return url
}

export const resolvePublicAddresses: ResolveAddresses = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }))
}

export async function pinPublicAddress(
  url: URL,
  resolve: ResolveAddresses,
  signal: AbortSignal
): Promise<PublicAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  const family = isIP(hostname)
  const addresses = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : await withAbort(resolve(hostname), signal)
  if (
    !addresses.length ||
    addresses.length > 32 ||
    addresses.some(({ address, family }) => isIP(address) !== family || !isPublicAddress(address))
  ) {
    throw new Error('Web preview address resolved to a private or reserved network')
  }
  return addresses.find(({ family }) => family === 4) ?? addresses[0]
}

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Web preview timed out'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false
  const halves = address.toLowerCase().split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const parts = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  const words = parts.map((part) => Number.parseInt(part, 16))
  // Only globally routed unicast, excluding documentation and transition ranges.
  return (
    (words[0] & 0xe000) === 0x2000 &&
    words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) &&
    !(words[0] === 0x3fff && words[1] < 0x1000)
  )
}
