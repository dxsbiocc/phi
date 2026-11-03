/**
 * Shell commands must never change the user's shell profiles, credentials or
 * tool configuration in their home directory. Other writes outside the project
 * still go through the approval prompt; these cannot be approved.
 */

const PROTECTED_HOME_ENTRIES = [
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.cshrc',
  '.tcshrc',
  '.kshrc',
  '.condarc',
  '.mambarc',
  '.netrc',
  '.gitconfig',
  '.npmrc',
  '.Rprofile',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.config'
]

// `~/x`, `$HOME/x`, `${HOME}/x`, `/home/<user>/x`, `/Users/<user>/x`, `/root/x`.
const HOME_PREFIX = String.raw`(?:~|\$HOME|\$\{HOME\}|/home/[^/\s'"]+|/Users/[^/\s'"]+|/root)`
const ENTRY = PROTECTED_HOME_ENTRIES.map((entry) => entry.replace('.', '\\.')).join('|')
const PROTECTED_PATH = new RegExp(String.raw`^['"]?${HOME_PREFIX}/(?:${ENTRY})(?:/|['"]?$)`)

// Commands that write one of their file arguments.
const WRITING_COMMANDS = new Set([
  'cp',
  'mv',
  'install',
  'ln',
  'rm',
  'rmdir',
  'touch',
  'truncate',
  'tee',
  'chmod',
  'chown',
  'mkdir',
  'rsync',
  'dd'
])

const COPYING_COMMANDS = new Set(['cp', 'install', 'ln', 'rsync', 'dd'])

// Installers that edit shell profiles themselves.
const PROFILE_EDITORS = [
  /^(?:conda|mamba)\s+init\b/,
  /^micromamba\s+shell\s+init\b/,
  /^(?:conda|mamba|micromamba)\s+config\b.*--(?:set|add|append|prepend|remove)\b/
]

function words(command: string): string[] {
  return command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? []
}

function isProtected(word: string): boolean {
  return PROTECTED_PATH.test(word.replace(/^(?:of|--?[\w-]+)=/, ''))
}

function simpleCommandWrite(command: string): string | undefined {
  const trimmed = command.trim().replace(/^(?:sudo\s+|env\s+|(?:\w+=\S*\s+))+/, '')
  if (PROFILE_EDITORS.some((pattern) => pattern.test(trimmed))) return trimmed.split(/\s+/)[0]
  // Redirections anywhere, including inside `bash -c "…"`.
  for (const match of trimmed.matchAll(/>>?\|?\s*([^\s;&|<>]+)/g)) {
    if (isProtected(match[1])) return match[1]
  }
  const tokens = words(trimmed)
  const name = tokens[0]?.split('/').pop() ?? ''
  const inPlaceEdit =
    (name === 'sed' || name === 'perl') && tokens.some((token) => /^-\w*i/.test(token))
  if (!WRITING_COMMANDS.has(name) && !inPlaceEdit) return undefined
  const args = tokens.slice(1)
  // These only write their last argument (or `of=`); reading a protected source is fine.
  if (COPYING_COMMANDS.has(name)) {
    const operands = args.filter((arg) => !arg.startsWith('-'))
    return (name === 'dd' ? args.filter((arg) => arg.startsWith('of=')) : operands.slice(-1)).find(
      isProtected
    )
  }
  return args.find(isProtected)
}

/** The protected home file a shell command would write, if any. */
export function protectedShellWrite(command: string): string | undefined {
  for (const part of command.split(/\n|;|&&|\|\||\|(?!\|)|&(?!&)/)) {
    const target = simpleCommandWrite(part)
    if (target) return target
  }
  return undefined
}
