import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { globSync } from 'glob'

import { validateHostAlias } from './wrappers/remote-ssh-session'

const execFileAsync = promisify(execFile)
const MAX_CONFIG_FILES = 64
const MAX_ALIASES = 64

export interface OpenSshHost {
  alias: string
  hostname?: string
  user?: string
  port?: number
  identityFiles: string[]
}

function directiveWords(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const character of line) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = null
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '#') {
      break
    } else if (/\s/.test(character)) {
      if (current) words.push(current)
      current = ''
    } else {
      current += character
    }
  }
  if (current) words.push(current)
  return words
}

function expandInclude(pattern: string, sshDir: string): string[] {
  const expanded = pattern === '~' ? homedir() : pattern.replace(/^~\//, `${homedir()}/`)
  const absolute = isAbsolute(expanded) ? expanded : join(sshDir, expanded)
  return globSync(absolute, { absolute: true, nodir: true }).sort()
}

/** Enumerate explicit Host aliases, including OpenSSH Include files, without connecting. */
export function discoverOpenSshAliases(configPath = join(homedir(), '.ssh', 'config')): string[] {
  if (!existsSync(configPath)) return []
  const sshDir = dirname(configPath)
  const visited = new Set<string>()
  const aliases = new Set<string>()
  const visit = (path: string): void => {
    const absolute = resolve(path)
    if (visited.has(absolute) || visited.size >= MAX_CONFIG_FILES) return
    visited.add(absolute)
    let source: string
    try {
      if (statSync(absolute).size > 1024 * 1024) return
      source = readFileSync(absolute, 'utf8')
    } catch {
      return
    }
    for (const line of source.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
      const words = directiveWords(line)
      const directive = words[0]?.replace(/=$/, '').toLowerCase()
      if (directive === 'include') {
        for (const pattern of words.slice(1)) {
          for (const included of expandInclude(pattern, sshDir)) visit(included)
        }
      } else if (directive === 'host') {
        for (const alias of words.slice(1)) {
          if (aliases.size >= MAX_ALIASES) return
          try {
            aliases.add(validateHostAlias(alias))
          } catch {
            // Wildcards and negated Host patterns are matching rules, not selectable hosts.
          }
        }
      }
    }
  }
  visit(configPath)
  return [...aliases]
}

async function inspectAlias(alias: string, configPath: string): Promise<OpenSshHost> {
  try {
    const { stdout } = await execFileAsync('ssh', ['-G', '-F', configPath, alias], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 256 * 1024
    })
    const values = new Map<string, string[]>()
    for (const line of stdout.split(/\r?\n/)) {
      const separator = line.indexOf(' ')
      if (separator < 0) continue
      const key = line.slice(0, separator).toLowerCase()
      const value = line.slice(separator + 1).trim()
      if (!value) continue
      values.set(key, [...(values.get(key) ?? []), value])
    }
    const port = Number(values.get('port')?.[0])
    return {
      alias,
      hostname: values.get('hostname')?.[0],
      user: values.get('user')?.[0],
      ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {}),
      identityFiles: (values.get('identityfile') ?? [])
        .filter((path) => existsSync(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path))
        .slice(0, 8)
    }
  } catch {
    return { alias, identityFiles: [] }
  }
}

/** `ssh -G` evaluates the user's config locally; it does not open an SSH connection. */
export async function listOpenSshHosts(
  configPath = join(homedir(), '.ssh', 'config')
): Promise<OpenSshHost[]> {
  const aliases = discoverOpenSshAliases(configPath)
  const hosts: OpenSshHost[] = []
  for (let index = 0; index < aliases.length; index += 8) {
    hosts.push(
      ...(await Promise.all(
        aliases.slice(index, index + 8).map((alias) => inspectAlias(alias, configPath))
      ))
    )
  }
  return hosts
}
