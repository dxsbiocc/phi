import type {
  HostCapability,
  HostCapabilityProfile,
  HostContainerRuntimeCapabilities,
  HostStorageCapabilities
} from './types'
import { HOST_CAPABILITY_PROFILE_VERSION } from './types'
import {
  FAST_PROBE_END_SENTINEL,
  FAST_PROBE_START_SENTINEL,
  PROBE_END_SENTINEL,
  PROBE_START_SENTINEL,
  SLOW_PROBE_END_SENTINEL,
  SLOW_PROBE_START_SENTINEL
} from './probe-script'

const HELPER_MISSING = 'helper 未安装'
const KNOWN_OPERATING_SYSTEMS = [
  'linux',
  'darwin',
  'freebsd',
  'openbsd',
  'netbsd',
  'aix',
  'sunos'
] as const
const KNOWN_ARCHITECTURES = [
  'x86_64',
  'amd64',
  'aarch64',
  'arm64',
  'ppc64le',
  's390x',
  'riscv64',
  'i386',
  'i686'
] as const

interface ProbeBlock {
  rows: ReadonlyMap<string, string>
  hasStart: boolean
  hasEnd: boolean
  phase: 'legacy' | 'split'
  fastComplete: boolean
  slowStatus: 'complete' | 'incomplete' | 'timed-out' | 'failed'
}

interface SentinelBlock {
  rows: ReadonlyMap<string, string>
  hasStart: boolean
  hasEnd: boolean
}

interface ProbeParseOptions {
  slowFailure?: 'timed-out' | 'failed'
}

export interface ProbedHostCapabilityProfile extends HostCapabilityProfile {
  profileVersion: number
  helperCompatibility: HostCapability
  probe: HostCapability
  prerequisites: {
    perl: HostCapability
    python3: HostCapability
    tar: HostCapability
    sha256sum: HostCapability
  }
  storage: HostStorageCapabilities
  toolchain: HostCapabilityProfile['toolchain'] & {
    containerRuntimes: HostContainerRuntimeCapabilities
  }
}

function helperCompatibility(os: string | undefined, arch: string | undefined): HostCapability {
  if (!os || os === 'unknown') return unavailable('platform probe result is unavailable')
  if (os?.toLowerCase() !== 'linux') {
    return unavailable('remote helper supports Linux only')
  }
  if (!['x86_64', 'amd64', 'aarch64', 'arm64'].includes(arch?.toLowerCase() ?? '')) {
    return unavailable('unsupported remote helper architecture')
  }
  return { state: 'available' }
}

function unavailable(reason: string): HostCapability {
  return { state: 'unavailable', reason }
}

function knownValue(value: string | undefined, allowed: readonly string[]): string {
  const normalized = value?.toLowerCase()
  return normalized && allowed.includes(normalized) ? normalized : 'unknown'
}

function parseSentinelBlock(
  output: string,
  startSentinel: string,
  endSentinel: string
): SentinelBlock {
  const start = output.lastIndexOf(startSentinel)
  const end = start < 0 ? -1 : output.indexOf(endSentinel, start)
  const body =
    start < 0 ? '' : output.slice(start + startSentinel.length, end < 0 ? undefined : end)
  const entries = body.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
    const separator = line.indexOf('=')
    if (separator <= 0) return []
    return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]]
  })
  return { rows: new Map(entries), hasStart: start >= 0, hasEnd: end >= 0 }
}

function parseBlock(output: string, options: ProbeParseOptions): ProbeBlock {
  const fast = parseSentinelBlock(output, FAST_PROBE_START_SENTINEL, FAST_PROBE_END_SENTINEL)
  if (fast.hasStart) {
    const slow = parseSentinelBlock(output, SLOW_PROBE_START_SENTINEL, SLOW_PROBE_END_SENTINEL)
    const slowComplete = slow.hasEnd && slow.rows.get('probe.slow_complete') === '1'
    return {
      rows: new Map([...fast.rows, ...slow.rows]),
      hasStart: true,
      hasEnd: fast.hasEnd && slow.hasEnd,
      phase: 'split',
      fastComplete: fast.hasEnd && fast.rows.get('probe.fast_complete') === '1',
      slowStatus: options.slowFailure ?? (slowComplete ? 'complete' : 'incomplete')
    }
  }
  const legacy = parseSentinelBlock(output, PROBE_START_SENTINEL, PROBE_END_SENTINEL)
  return {
    ...legacy,
    phase: 'legacy',
    fastComplete: legacy.hasEnd && legacy.rows.get('probe.complete') === '1',
    slowStatus: 'complete'
  }
}

function probeCapability(block: ProbeBlock): HostCapability {
  if (!block.hasStart) return unavailable('probe output did not contain a valid sentinel block')
  if (block.phase === 'legacy') {
    if (!block.hasEnd || block.rows.get('probe.complete') !== '1') {
      return { state: 'degraded', reason: 'probe output was incomplete' }
    }
    return { state: 'available' }
  }
  if (!block.fastComplete) {
    return unavailable('fast capability detection was incomplete')
  }
  if (block.slowStatus === 'timed-out') {
    return { state: 'degraded', reason: 'slow capability detection timed out' }
  }
  if (block.slowStatus === 'failed') {
    return { state: 'degraded', reason: 'slow capability detection failed' }
  }
  if (block.slowStatus === 'incomplete') {
    return { state: 'degraded', reason: 'slow capability detection was incomplete' }
  }
  return { state: 'available' }
}

function prerequisite(rows: ReadonlyMap<string, string>, name: string): HostCapability {
  if (rows.get(`prerequisite.${name}.available`) === '1') return { state: 'available' }
  if (rows.get(`prerequisite.${name}.available`) === '0') {
    return unavailable(`${name} is not installed`)
  }
  return unavailable(`${name} availability could not be determined`)
}

function safeVersion(value: string | undefined): string | undefined {
  return value?.match(/\b\d+(?:\.\d+)+(?:[-+._][A-Za-z0-9]+)?\b/)?.[0]
}

function libc(
  rows: ReadonlyMap<string, string>
): NonNullable<HostCapabilityProfile['platform']['libc']> {
  const rawName = rows.get('libc.name')
  const name = rawName === 'glibc' || rawName === 'musl' ? rawName : 'unknown'
  const version = safeVersion(rows.get('libc.version'))
  return { name, ...(version ? { version } : {}) }
}

function availableSpace(rows: ReadonlyMap<string, string>): number | null {
  const raw = rows.get('storage.available_kib')
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

function availableSpaceCapability(value: number | null): HostCapability {
  return value === null
    ? unavailable('available disk space could not be determined')
    : { state: 'available' }
}

function incompleteDetection(label: string, status: ProbeBlock['slowStatus']): HostCapability {
  const detail =
    status === 'timed-out' ? 'timed out' : status === 'failed' ? 'failed' : 'was incomplete'
  return { state: 'degraded', reason: `${label} detection ${detail}` }
}

function sharedFileSystem(
  value: string | undefined,
  status: ProbeBlock['slowStatus']
): HostCapability {
  if (value === '1') return { state: 'available' }
  if (value === '0') return unavailable('filesystem appears to be local')
  if (status !== 'complete') return incompleteDetection('shared filesystem', status)
  return unavailable('shared filesystem could not be determined')
}

function toolCapability(
  rows: ReadonlyMap<string, string>,
  key: string,
  label: string,
  status: ProbeBlock['slowStatus']
): HostCapability {
  const availability = rows.get(`tool.${key}.available`)
  if (rows.get(`tool.${key}.version_timeout`) === '1') {
    return { state: 'degraded', reason: `${label} version check timed out` }
  }
  if (availability === 'unknown') {
    return { state: 'degraded', reason: `${label} availability could not be determined` }
  }
  if (availability === '0') {
    return unavailable(`${label} is not installed`)
  }
  if (availability !== '1') {
    if (status !== 'complete') return incompleteDetection(label, status)
    return unavailable(`${label} availability could not be determined`)
  }
  if (rows.get(`tool.${key}.version_unavailable`) === '1') {
    return { state: 'degraded', reason: `${label} version check failed` }
  }
  const version = safeVersion(rows.get(`tool.${key}.version`))
  return { state: 'available', ...(version ? { version } : {}) }
}

function containerRuntimes(
  rows: ReadonlyMap<string, string>,
  status: ProbeBlock['slowStatus']
): HostContainerRuntimeCapabilities {
  return {
    docker: toolCapability(rows, 'container.docker', 'docker', status),
    singularity: toolCapability(rows, 'container.singularity', 'singularity', status),
    apptainer: toolCapability(rows, 'container.apptainer', 'apptainer', status),
    podman: toolCapability(rows, 'container.podman', 'podman', status)
  }
}

function containerCapability(
  rows: ReadonlyMap<string, string>,
  runtimes: HostContainerRuntimeCapabilities,
  status: ProbeBlock['slowStatus']
): HostCapability {
  if (rows.has('tool.container.available')) {
    const legacy = toolCapability(rows, 'container', 'container runtime', status)
    const name = rows.get('tool.container.name')
    const safeName = ['docker', 'singularity', 'apptainer', 'podman'].find((item) => item === name)
    if (legacy.state !== 'available') return legacy
    if (!safeName) return unavailable('container runtime probe result is unavailable')
    return {
      ...legacy,
      version: legacy.version ? `${safeName} ${legacy.version}` : safeName
    }
  }
  const observedRuntime = ['docker', 'singularity', 'apptainer', 'podman'].some((name) =>
    rows.has(`tool.container.${name}.available`)
  )
  if (status !== 'complete' && !observedRuntime) {
    return incompleteDetection('container runtime', status)
  }
  const available = Object.entries(runtimes).find(([, capability]) =>
    ['available', 'degraded'].includes(capability.state)
  )
  if (!available) return unavailable('container runtime is not installed')
  const [name, capability] = available
  return {
    ...capability,
    ...(capability.version ? { version: `${name} ${capability.version}` } : {})
  }
}

function flagCapability(value: string | undefined, unavailableReason: string): HostCapability {
  if (value === '1') return { state: 'available' }
  if (value === '0') return unavailable(unavailableReason)
  return unavailable('probe result is unavailable')
}

function transportCapability(block: ProbeBlock): HostCapability {
  return block.hasStart ? { state: 'available' } : unavailable('probe result is unavailable')
}

function platform(rows: ReadonlyMap<string, string>): ProbedHostCapabilityProfile['platform'] {
  return {
    os: knownValue(rows.get('platform.os'), KNOWN_OPERATING_SYSTEMS),
    arch: knownValue(rows.get('platform.arch'), KNOWN_ARCHITECTURES),
    libc: libc(rows)
  }
}

function storage(block: ProbeBlock): HostStorageCapabilities {
  const { rows } = block
  const availableSpaceKiB = availableSpace(rows)
  return {
    homeWritable: flagCapability(
      rows.get('storage.home_writable'),
      'home directory is not writable'
    ),
    homeExecutable: flagCapability(
      rows.get('storage.home_executable'),
      'home directory blocks executable files'
    ),
    availableSpace: availableSpaceCapability(availableSpaceKiB),
    availableSpaceKiB,
    sharedFileSystem: sharedFileSystem(rows.get('storage.shared'), block.slowStatus)
  }
}

function toolchain(block: ProbeBlock): ProbedHostCapabilityProfile['toolchain'] {
  const { rows, slowStatus } = block
  const runtimes = containerRuntimes(rows, slowStatus)
  return {
    git: toolCapability(rows, 'git', 'git', slowStatus),
    nextflow: toolCapability(rows, 'nextflow', 'nextflow', slowStatus),
    java: toolCapability(rows, 'java', 'java', slowStatus),
    conda: toolCapability(rows, 'conda', 'conda', slowStatus),
    sbatch: toolCapability(rows, 'sbatch', 'sbatch', slowStatus),
    containerRuntime: containerCapability(rows, runtimes, slowStatus),
    containerRuntimes: runtimes,
    module: toolCapability(rows, 'module', 'module', slowStatus)
  }
}

function baseProfile(block: ProbeBlock): ProbedHostCapabilityProfile {
  const { rows } = block
  const helperMissing = (): HostCapability => unavailable(HELPER_MISSING)
  const detectedPlatform = platform(rows)
  return {
    profileVersion: HOST_CAPABILITY_PROFILE_VERSION,
    platform: detectedPlatform,
    probedAt: new Date().toISOString(),
    helperCompatibility: helperCompatibility(detectedPlatform.os, detectedPlatform.arch),
    probe: probeCapability(block),
    fs: transportCapability(block),
    exec: transportCapability(block),
    background: transportCapability(block),
    pty: helperMissing(),
    watch: helperMissing(),
    forwardPort: helperMissing(),
    prerequisites: {
      perl: prerequisite(rows, 'perl'),
      python3: prerequisite(rows, 'python3'),
      tar: prerequisite(rows, 'tar'),
      sha256sum: prerequisite(rows, 'sha256sum')
    },
    storage: storage(block),
    toolchain: toolchain(block)
  }
}

export function parseHostCapabilityProbe(
  output: string,
  options: ProbeParseOptions = {}
): ProbedHostCapabilityProfile {
  return baseProfile(parseBlock(output, options))
}
