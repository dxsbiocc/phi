import { posix } from 'node:path'

import type { ProjectLocation } from '../../shared/projectLocation'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import { getPhiAgentDir } from './runtime-paths'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from './wrappers/remote-ssh-session'

type SshLocation = Extract<ProjectLocation, { kind: 'ssh' }>

export type RemoteProjectInstruction = { path: string; content: string }

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const
const MAX_INSTRUCTION_BYTES = 64 * 1024
const MISSING_FILE_EXIT = 10

export interface RemoteProjectInstructionDependencies {
  agentDir?: string
  connectImpl?: (config: RemoteConnectionConfig) => Promise<RemoteSshSession>
}

/** Read only named, bounded root instructions from the registered SSH project. */
export function buildRemoteInstructionReadCommand(
  location: SshLocation,
  fileName: (typeof INSTRUCTION_FILES)[number]
): string {
  if (
    !INSTRUCTION_FILES.includes(fileName) ||
    !posix.isAbsolute(location.remoteRoot) ||
    !posix.isAbsolute(location.canonicalRoot) ||
    /[\r\n\0]/.test(location.remoteRoot) ||
    /[\r\n\0]/.test(location.canonicalRoot)
  ) {
    throw new Error('远程项目目录无效')
  }
  const script = [
    'set -eu',
    `cd -P -- ${shellQuote(location.remoteRoot)}`,
    `[ "$(pwd -P)" = ${shellQuote(location.canonicalRoot)} ] || exit 21`,
    `file=${shellQuote(fileName)}`,
    'if [ ! -e "$file" ]; then',
    '  [ ! -L "$file" ] || exit 23',
    `  exit ${MISSING_FILE_EXIT}`,
    'fi',
    '[ ! -L "$file" ] || exit 23',
    '[ -f "$file" ] || exit 24',
    '[ -r "$file" ] || exit 25',
    'size=$(wc -c < "$file") || exit 26',
    `[ "$size" -le ${MAX_INSTRUCTION_BYTES} ] || exit 27`,
    `head -c ${MAX_INSTRUCTION_BYTES + 1} < "$file"`
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

export async function loadRemoteProjectInstructions(
  location: SshLocation,
  dependencies: RemoteProjectInstructionDependencies = {}
): Promise<RemoteProjectInstruction[]> {
  const profile = getRemoteHostProfile(
    location.hostProfileId,
    dependencies.agentDir ?? getPhiAgentDir()
  )
  if (!profile) throw new Error('远程项目的 SSH 服务器档案不可用')
  const connect = dependencies.connectImpl ?? connectRemoteSshSession
  const session = await connect({
    ...remoteConnectionConfigForProfile(profile),
    readyTimeoutMs: 10_000,
    execTimeoutMs: 5_000
  })
  const instructions: RemoteProjectInstruction[] = []
  try {
    for (const fileName of INSTRUCTION_FILES) {
      const result = await session.exec(buildRemoteInstructionReadCommand(location, fileName))
      if (result.code === MISSING_FILE_EXIT) continue
      if (result.code !== 0) {
        throw new Error(`远程项目指令读取失败：${fileName}（状态 ${result.code ?? '未知'}）`)
      }
      if (
        Buffer.byteLength(result.stdout, 'utf-8') > MAX_INSTRUCTION_BYTES ||
        result.stdout.includes('\0')
      ) {
        throw new Error(`远程项目指令格式或大小无效：${fileName}`)
      }
      instructions.push({
        path: `ssh://${profile.hostAlias}${posix.join(location.remoteRoot, fileName)}`,
        content: result.stdout
      })
    }
    return instructions
  } finally {
    await session.close()
  }
}
