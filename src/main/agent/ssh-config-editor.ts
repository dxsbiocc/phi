import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { OpenSshHostInput } from '../../shared/remoteHostProfile'
import { discoverOpenSshAliases } from './ssh-config-discovery'
import { validateHostAlias, validateRemoteConnectionOverrides } from './wrappers/remote-ssh-session'

const execFileAsync = promisify(execFile)
const MANAGED_DIRECTIVE = /^\s*(?:HostName|User|Port|IdentityFile)\s+/i
const SECTION_DIRECTIVE = /^\s*(?:Host|Match)\s+/i

function checkedInput(input: OpenSshHostInput): OpenSshHostInput {
  if (!input || typeof input.alias !== 'string' || typeof input.hostname !== 'string') {
    throw new Error('SSH 服务器配置无效')
  }
  const alias = validateHostAlias(input.alias.trim())
  const originalAlias = input.originalAlias
    ? validateHostAlias(input.originalAlias.trim())
    : undefined
  if (originalAlias && originalAlias !== alias) {
    throw new Error('已配置的 SSH 主机别名不能直接改名；请新建主机后更新项目绑定')
  }
  const hostname = input.hostname.trim()
  if (!hostname || hostname.length > 255 || /[\s#\0]/.test(hostname) || hostname.startsWith('-')) {
    throw new Error('服务器地址必须是单个主机名或 IP 地址')
  }
  return {
    alias,
    hostname,
    ...(originalAlias ? { originalAlias } : {}),
    ...validateRemoteConnectionOverrides(input)
  }
}

function hostWords(line: string): string[] | null {
  const match = /^\s*Host\s+([^#]*?)(?:\s+#.*)?$/i.exec(line)
  return match ? match[1].trim().split(/\s+/).filter(Boolean) : null
}

function quoteConfigValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function hostBlock(input: OpenSshHostInput): string[] {
  return [
    `Host ${input.alias}`,
    `  HostName ${input.hostname}`,
    ...(input.user ? [`  User ${input.user}`] : []),
    ...(input.port ? [`  Port ${input.port}`] : []),
    ...(input.identityFile ? [`  IdentityFile ${quoteConfigValue(input.identityFile)}`] : [])
  ]
}

/** Preserve unrelated Host blocks, comments, jump settings and global directives. */
export function updatedOpenSshConfig(
  source: string,
  input: OpenSshHostInput,
  configuredAliases: string[]
): string {
  const checked = checkedInput(input)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source ? source.split(/\r?\n/) : []
  if (!checked.originalAlias) {
    if (configuredAliases.includes(checked.alias)) {
      throw new Error('该别名已存在于 SSH 配置；请编辑列表中的主机')
    }
    const firstSection = lines.findIndex((line) => SECTION_DIRECTIVE.test(line))
    const before = firstSection < 0 ? lines : lines.slice(0, firstSection)
    const after = firstSection < 0 ? [] : lines.slice(firstSection)
    const result = [...before]
    if (result.length && result.at(-1) !== '') result.push('')
    result.push(...hostBlock(checked), '', ...after)
    return `${result.join(eol).replace(/(?:\r?\n)*$/, '')}${eol}`
  }

  if (!configuredAliases.includes(checked.originalAlias)) {
    throw new Error('SSH 配置中找不到该主机，请刷新列表')
  }
  const matches = lines.flatMap((line, index) => {
    const words = hostWords(line)
    return words?.includes(checked.originalAlias!) ? [{ index, words }] : []
  })
  if (matches.length !== 1 || matches[0].words.length !== 1) {
    throw new Error('该别名位于 Include 文件或共享 Host 规则中；请在原 SSH 配置文件中编辑')
  }
  const start = matches[0].index
  const nextSection = lines.findIndex(
    (line, index) => index > start && SECTION_DIRECTIVE.test(line)
  )
  const end = nextSection < 0 ? lines.length : nextSection
  const kept = lines.slice(start + 1, end).filter((line) => !MANAGED_DIRECTIVE.test(line))
  const result = [
    ...lines.slice(0, start),
    lines[start],
    ...hostBlock(checked).slice(1),
    ...kept,
    ...lines.slice(end)
  ]
  return `${result.join(eol).replace(/(?:\r?\n)*$/, '')}${eol}`
}

function effectiveValue(output: string, name: string): string[] {
  return output
    .split(/\r?\n/)
    .flatMap((line) =>
      line.toLowerCase().startsWith(`${name.toLowerCase()} `)
        ? [line.slice(name.length + 1).trim()]
        : []
    )
}

async function validateEffectiveConfig(path: string, input: OpenSshHostInput): Promise<void> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('ssh', ['-G', '-F', path, input.alias], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 256 * 1024
    }))
  } catch {
    throw new Error('OpenSSH 无法解析修改后的配置；原文件未改变')
  }
  if (effectiveValue(stdout, 'hostname')[0]?.toLowerCase() !== input.hostname.toLowerCase()) {
    throw new Error('其他 SSH 规则覆盖了服务器地址；原文件未改变')
  }
  if (input.user && effectiveValue(stdout, 'user')[0] !== input.user) {
    throw new Error('其他 SSH 规则覆盖了用户名；原文件未改变')
  }
  if (input.port && Number(effectiveValue(stdout, 'port')[0]) !== input.port) {
    throw new Error('其他 SSH 规则覆盖了端口；原文件未改变')
  }
  if (input.identityFile && !effectiveValue(stdout, 'identityfile').includes(input.identityFile)) {
    throw new Error('OpenSSH 未读取所选私钥路径；原文件未改变')
  }
}

/** Writes only an explicit host stanza to the user's OpenSSH config after local validation. */
export async function saveOpenSshHost(
  value: OpenSshHostInput,
  configPath = join(homedir(), '.ssh', 'config')
): Promise<string> {
  const input = checkedInput(value)
  const directory = dirname(configPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let original = ''
  let mode = 0o600
  let existed = false
  try {
    const info = await lstat(configPath)
    if (!info.isFile()) throw new Error('SSH 配置不是普通文件，请手动处理')
    if (info.size > 1024 * 1024) throw new Error('SSH 配置文件过大，请手动编辑')
    mode = info.mode & 0o777
    original = await readFile(configPath, 'utf8')
    existed = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = updatedOpenSshConfig(original, input, discoverOpenSshAliases(configPath))
  const temp = join(directory, `.phi-ssh-config-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(next, 'utf8')
    await handle.sync()
    await handle.chmod(mode)
    await handle.close()
    handle = undefined
    await validateEffectiveConfig(temp, input)
    if (existed) {
      if ((await readFile(configPath, 'utf8')) !== original) {
        throw new Error('SSH 配置在保存期间被其他程序修改，请重试')
      }
      const backup = `${configPath}.phi-backup-${Date.now()}-${randomUUID().slice(0, 8)}`
      await copyFile(configPath, backup, constants.COPYFILE_EXCL)
      await chmod(backup, 0o600)
    } else {
      try {
        await lstat(configPath)
        throw new Error('SSH 配置在保存期间由其他程序创建，请重试')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await rename(temp, configPath)
    return input.alias
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
  }
}
