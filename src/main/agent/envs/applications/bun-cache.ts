import { parse } from 'semver'

const MASK = (1n << 64n) - 1n
const SECRETS = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n,
  0x1d8e4e27c47d124fn
]

function multiplyFold(left: bigint, right: bigint): bigint {
  const product = left * right
  return ((product >> 64n) ^ product) & MASK
}

function mix(left: bigint, right: bigint, seed: bigint, offset: number): bigint {
  return multiplyFold(left ^ seed ^ SECRETS[offset], right ^ seed ^ SECRETS[offset + 1])
}

function shortWord(bytes: Buffer): bigint {
  if (!bytes.length) return 0n
  const count = bytes.length >= 4 ? 4 : bytes.length >= 2 ? 2 : 1
  let first = 0n
  for (let index = 0; index < count; index++) first |= BigInt(bytes[index]) << BigInt(index * 8)
  return (first << BigInt((bytes.length - count) * 8)) | shortWord(bytes.subarray(count))
}

// Bun 1.3.14 keeps this older Wyhash ABI for lock/cache tags; Bun.hash.wyhash uses a different ABI.
// https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/wyhash/wyhash.zig
function cacheTagHash(value: string): string {
  const bytes = Buffer.from(value)
  let seed = 0n
  let offset = 0
  for (; offset + 32 <= bytes.length; offset += 32) {
    seed =
      mix(bytes.readBigUInt64LE(offset), bytes.readBigUInt64LE(offset + 8), seed, 0) ^
      mix(bytes.readBigUInt64LE(offset + 16), bytes.readBigUInt64LE(offset + 24), seed, 2)
  }
  const tail = bytes.subarray(offset)
  if (tail.length) {
    seed =
      mix(
        shortWord(tail.subarray(0, 8)),
        tail.length > 8 ? shortWord(tail.subarray(8, 16)) : SECRETS[4],
        seed,
        0
      ) ^
      (tail.length > 16
        ? mix(
            shortWord(tail.subarray(16, 24)),
            tail.length > 24 ? shortWord(tail.subarray(24)) : SECRETS[4],
            seed,
            2
          )
        : 0n)
  }
  return multiplyFold(seed ^ BigInt(bytes.length), SECRETS[4]).toString(16)
}

/** Default-registry cache-v1 layout, tested only against the exact pinned Bun 1.3.14 runtime. */
export function bunCachePackagePath(name: string, version: string, bunVersion: string): string {
  if (bunVersion !== '1.3.14')
    throw new Error(
      `Bun application: offline cache ABI is unsupported for Bun ${bunVersion}; requires managed Bun 1.3.14`
    )
  const parsed = parse(version)
  if (!parsed) throw new Error('Bun application: invalid locked package version')
  const pre = parsed.prerelease.length ? `-${cacheTagHash(parsed.prerelease.join('.'))}` : ''
  const build = parsed.build.length ? `+${cacheTagHash(parsed.build.join('.')).toUpperCase()}` : ''
  return `${name}@${parsed.major}.${parsed.minor}.${parsed.patch}${pre}${build}@@@1`
}
