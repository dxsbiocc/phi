import { mkdtemp, mkdir, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const E5_PROJECT_ID = 'e943f72e-80b4-460a-8848-d4d4da37f5ca'
export const E5_REMOTE_ROOT = '/data2/dengxsh/phi-test'

export type E5Model = { providerId: string; modelId: string }
export type E5Project = {
  id: string
  name: string
  location: { kind: string; hostProfileId?: string; remoteRoot?: string; canonicalRoot?: string }
  defaultModel?: E5Model
}

export async function readE5Project(sourceAgentDir: string): Promise<E5Project> {
  const raw: unknown = JSON.parse(await readFile(join(sourceAgentDir, 'projects.json'), 'utf8'))
  const projects = Array.isArray(raw) ? raw : (raw as { projects?: unknown }).projects
  if (!Array.isArray(projects)) throw new Error('Phi project registry is unavailable')
  const project = projects.find(
    (entry): entry is E5Project =>
      typeof entry === 'object' && entry !== null && entry.id === E5_PROJECT_ID
  )
  if (
    project?.name !== 'phi-test' ||
    project.location?.kind !== 'ssh' ||
    project.location.hostProfileId !== 'ssh-config:GPU' ||
    project.location.remoteRoot !== E5_REMOTE_ROOT ||
    project.location.canonicalRoot !== E5_REMOTE_ROOT
  )
    throw new Error('Exact phi-test SSH project binding is unavailable')
  return project
}

export async function readE5Model(sourceAgentDir: string, project: E5Project): Promise<E5Model> {
  const settings: unknown = JSON.parse(
    await readFile(join(sourceAgentDir, 'settings.json'), 'utf8')
  )
  const choice =
    project.defaultModel ?? (settings as { lastSelectedModel?: E5Model }).lastSelectedModel
  if (
    !choice?.providerId ||
    !choice.modelId ||
    !/^[A-Za-z0-9._-]+$/.test(choice.providerId) ||
    !/^[A-Za-z0-9._-]+$/.test(choice.modelId)
  )
    throw new Error('Choose a concrete model before E5')
  return { providerId: choice.providerId, modelId: choice.modelId }
}

export type E5PreparedProfile = {
  root: string
  homeDir: string
  agentDir: string
  userDataDir: string
  model: E5Model
}

async function isolatedGpuSshConfig(sourceHomeDir: string): Promise<string> {
  const source = await readFile(join(sourceHomeDir, '.ssh', 'config'), 'utf8')
  let inGpu = false
  const fields = new Map<string, string>()
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(line)
    if (!match || match[1].startsWith('#')) continue
    const key = match[1].toLowerCase()
    if (key === 'host' || key === 'match') {
      if (inGpu) break
      inGpu = key === 'host' && match[2] === 'GPU'
      continue
    }
    if (inGpu && ['hostname', 'user', 'port'].includes(key)) {
      if (fields.has(key)) throw new Error(`Duplicate GPU SSH ${key}`)
      fields.set(key, match[2])
    }
  }
  const host = fields.get('hostname')
  const user = fields.get('user')
  const port = fields.get('port')
  if (
    !host ||
    !/^[A-Za-z0-9.-]+$/.test(host) ||
    !user ||
    !/^[A-Za-z0-9._-]+$/.test(user) ||
    !port ||
    !/^\d{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw new Error('GPU SSH alias is not a simple HostName/User/Port profile')
  const knownHosts = join(sourceHomeDir, '.ssh', 'known_hosts')
  if (!(await stat(knownHosts)).isFile()) throw new Error('Known hosts file is unavailable')
  return [
    'Host GPU',
    `  HostName ${host}`,
    `  User ${user}`,
    `  Port ${port}`,
    '  BatchMode yes',
    '  StrictHostKeyChecking yes',
    '  UpdateHostKeys no',
    '  ControlMaster no',
    `  UserKnownHostsFile ${knownHosts}`,
    ''
  ].join('\n')
}

/** Copies an explicit, small allowlist; no credential, session, log, or SSH file is read. */
export async function prepareE5Profile(
  sourceAgentDir: string,
  parentDir = '/tmp',
  sourceHomeDir = dirname(sourceAgentDir)
): Promise<E5PreparedProfile> {
  const project = await readE5Project(sourceAgentDir)
  const model = await readE5Model(sourceAgentDir, project)
  const sshConfig = await isolatedGpuSshConfig(sourceHomeDir)
  const root = await mkdtemp(join(parentDir, 'phi-e5-'))
  try {
    const homeDir = join(root, 'home')
    const agentDir = join(homeDir, '.phi')
    const userDataDir = join(root, 'user-data')
    const sshDir = join(homeDir, '.ssh')
    await mkdir(agentDir, { recursive: true, mode: 0o700 })
    await mkdir(userDataDir, { mode: 0o700 })
    await mkdir(sshDir, { mode: 0o700 })
    await writeFile(join(sshDir, 'config'), sshConfig, { mode: 0o600, flag: 'wx' })
    await writeFile(
      join(agentDir, 'projects.json'),
      JSON.stringify([
        {
          id: E5_PROJECT_ID,
          name: 'phi-test',
          location: {
            kind: 'ssh',
            hostProfileId: 'ssh-config:GPU',
            remoteRoot: E5_REMOTE_ROOT,
            canonicalRoot: E5_REMOTE_ROOT
          },
          workingDirectory: E5_REMOTE_ROOT,
          workingDirectoryRealPath: E5_REMOTE_ROOT,
          permissionMode: 'ask',
          pathAvailable: true,
          remoteHostAlias: 'GPU',
          defaultModel: model,
          createdAt: new Date().toISOString()
        }
      ]) + '\n',
      { mode: 0o600, flag: 'wx' }
    )
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ lastSelectedModel: model }) + '\n',
      {
        mode: 0o600,
        flag: 'wx'
      }
    )
    await writeFile(join(agentDir, 'onboarding.json'), '{"onboarded":true}\n', {
      mode: 0o600,
      flag: 'wx'
    })
    const canonicalRoot = await realpath(root)
    if (!/^\/(?:private\/)?tmp\/phi-e5-[A-Za-z0-9-]+$/.test(canonicalRoot))
      throw new Error('E5 profile escaped the isolated temporary root')
    for (const path of [root, homeDir, agentDir, userDataDir, sshDir]) {
      if ((await stat(path)).mode & 0o077)
        throw new Error('E5 profile directory is accessible to others')
    }
    const entries = (await readdir(agentDir)).sort()
    if (entries.join(',') !== 'onboarding.json,projects.json,settings.json')
      throw new Error('Unexpected E5 profile contents')
    if ((await readdir(sshDir)).join(',') !== 'config')
      throw new Error('Unexpected E5 SSH contents')
    return { root, homeDir, agentDir, userDataDir, model }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
