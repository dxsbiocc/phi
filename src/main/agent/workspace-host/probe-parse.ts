import type {
  HostCapability,
  HostCapabilityProfile,
  HostContainerRuntimeCapabilities,
  HostStorageCapabilities
} from './types'
import { HOST_CAPABILITY_PROFILE_VERSION } from './types'
import { PROBE_END_SENTINEL, PROBE_START_SENTINEL } from './probe-script'

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

function parseBlock(output: string): ProbeBlock {
  const start = output.lastIndexOf(PROBE_START_SENTINEL)
  const end = start < 0 ? -1 : output.indexOf(PROBE_END_SENTINEL, start)
  const body =
    start < 0 ? '' : output.slice(start + PROBE_START_SENTINEL.length, end < 0 ? undefined : end)
  const entries = body.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
    const separator = line.indexOf('=')
    if (separator <= 0) return []
    return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]]
  })
  return { rows: new Map(entries), hasStart: start >= 0, hasEnd: end >= 0 }
}

function probeCapability(block: ProbeBlock): HostCapability {
  if (!block.hasStart) return unavailable('probe output did not contain a valid sentinel block')
  if (!block.hasEnd || block.rows.get('probe.complete') !== '1') {
    return { state: 'degraded', reason: 'probe output was incomplete' }
  }
  return { state: 'available' }
}

function prerequisite(rows: ReadonlyMap<string, string>, name: string): HostCapability {
  if (rows.get(`prerequisite.${name}.available`) === '1') return { state: 'available' }
  return unavailable(`${name} is not installed`)
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

function sharedFileSystem(value: string | undefined): HostCapability {
  if (value === '1') return { state: 'available' }
  if (value === '0') return unavailable('filesystem appears to be local')
  return unavailable('shared filesystem could not be determined')
}

function toolCapability(
  rows: ReadonlyMap<string, string>,
  key: string,
  label = key
): HostCapability {
  const availability = rows.get(`tool.${key}.available`)
  if (availability === '0') {
    return unavailable(`${label} is not installed`)
  }
  if (availability !== '1') {
    return unavailable(`${label} availability could not be determined`)
  }
  if (rows.get(`tool.${key}.version_timeout`) === '1') {
    return { state: 'degraded', reason: `${label} version check timed out` }
  }
  if (rows.get(`tool.${key}.version_unavailable`) === '1') {
    return { state: 'degraded', reason: `${label} version check failed` }
  }
  const version = safeVersion(rows.get(`tool.${key}.version`))
  return { state: 'available', ...(version ? { version } : {}) }
}

function containerRuntimes(rows: ReadonlyMap<string, string>): HostContainerRuntimeCapabilities {
  return {
    docker: toolCapability(rows, 'container.docker', 'docker'),
    singularity: toolCapability(rows, 'container.singularity', 'singularity'),
    apptainer: toolCapability(rows, 'container.apptainer', 'apptainer'),
    podman: toolCapability(rows, 'container.podman', 'podman')
  }
}

function containerCapability(
  rows: ReadonlyMap<string, string>,
  runtimes: HostContainerRuntimeCapabilities
): HostCapability {
  if (rows.has('tool.container.available')) {
    const legacy = toolCapability(rows, 'container', 'container runtime')
    const name = rows.get('tool.container.name')
    const safeName = ['docker', 'singularity', 'apptainer', 'podman'].find((item) => item === name)
    if (legacy.state !== 'available') return legacy
    if (!safeName) return unavailable('container runtime probe result is unavailable')
    return {
      ...legacy,
      version: legacy.version ? `${safeName} ${legacy.version}` : safeName
    }
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

function storage(rows: ReadonlyMap<string, string>): HostStorageCapabilities {
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
    sharedFileSystem: sharedFileSystem(rows.get('storage.shared'))
  }
}

function toolchain(rows: ReadonlyMap<string, string>): ProbedHostCapabilityProfile['toolchain'] {
  const runtimes = containerRuntimes(rows)
  return {
    git: toolCapability(rows, 'git'),
    nextflow: toolCapability(rows, 'nextflow'),
    java: toolCapability(rows, 'java'),
    conda: toolCapability(rows, 'conda'),
    sbatch: toolCapability(rows, 'sbatch'),
    containerRuntime: containerCapability(rows, runtimes),
    containerRuntimes: runtimes,
    module: toolCapability(rows, 'module')
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
    storage: storage(rows),
    toolchain: toolchain(rows)
  }
}

export function parseHostCapabilityProbe(output: string): ProbedHostCapabilityProfile {
  return baseProfile(parseBlock(output))
}
