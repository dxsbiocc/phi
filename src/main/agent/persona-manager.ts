import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPhiAgentDir } from './runtime-paths'

// Shares ~/.phi with agent-env.ts's PI_CODING_AGENT_DIR: the runtime resource loader
// already reads an AGENTS.md from the agent dir as global context for every session
// so writing the persona there is enough to make it part of the system prompt with
// no resourceLoader override needed. The file IS the persona — settings edits it directly.
const PHI_DIR = getPhiAgentDir()
const AGENTS_MD_PATH = join(PHI_DIR, 'AGENTS.md')
const ONBOARDING_STATE_PATH = join(PHI_DIR, 'onboarding.json')

function ensureDir(): void {
  if (!existsSync(PHI_DIR)) {
    mkdirSync(PHI_DIR, { recursive: true })
  }
}

export function getPersonaMarkdown(): string {
  if (!existsSync(AGENTS_MD_PATH)) {
    return ''
  }
  try {
    return readFileSync(AGENTS_MD_PATH, 'utf-8')
  } catch {
    return ''
  }
}

export function setPersonaMarkdown(markdown: string): void {
  ensureDir()
  const trimmed = markdown.trim()
  if (!trimmed) {
    // An empty persona means "use the SDK's own defaults" — remove the file
    // rather than leaving an empty one behind.
    if (existsSync(AGENTS_MD_PATH)) {
      unlinkSync(AGENTS_MD_PATH)
    }
  } else {
    writeFileSync(AGENTS_MD_PATH, `${trimmed}\n`, 'utf-8')
  }
  markOnboarded()
}

export function isOnboarded(): boolean {
  if (!existsSync(ONBOARDING_STATE_PATH)) {
    return false
  }
  try {
    const raw = JSON.parse(readFileSync(ONBOARDING_STATE_PATH, 'utf-8'))
    return Boolean(raw.onboarded)
  } catch {
    return false
  }
}

function markOnboarded(): void {
  ensureDir()
  writeFileSync(ONBOARDING_STATE_PATH, JSON.stringify({ onboarded: true }, null, 2), 'utf-8')
}

export function skipOnboarding(): void {
  markOnboarded()
}

/** Used when no model is configured yet to turn the description into config, or the
 * generation call itself fails — the description still ends up in the persona file. */
export function fallbackMarkdownFromDescription(description: string): string {
  return `# 助手人设\n\n${description.trim()}\n`
}
