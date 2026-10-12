import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProjectMemoryLesson } from '../../../shared/projectMemoryTypes'

/** SDK file names inside one project's memory root. */
export const MEMORY_SUMMARY_FILE = 'memory_summary.md'
export const LEARNED_LESSONS_FILE = 'learned.md'

/** Matches the SDK default `memories.summaryInjectionTokenLimit` (5000 tokens, ~4 chars each). */
const PROMPT_BLOCK_MAX_CHARS = 20_000

export interface ProjectMemoryFiles {
  summary: string
  summaryUpdatedAt: string | null
  lessons: ProjectMemoryLesson[]
}

function isLessonLine(line: string): boolean {
  return line.trimStart().startsWith('- ')
}

function lessonText(line: string): string {
  return line.trimStart().slice(2).trim()
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export function parseLearnedLessons(raw: string): ProjectMemoryLesson[] {
  return raw
    .split('\n')
    .filter(isLessonLine)
    .map((line, index) => ({ index, text: lessonText(line) }))
}

export async function readProjectMemoryFiles(root: string): Promise<ProjectMemoryFiles> {
  const summaryPath = join(root, MEMORY_SUMMARY_FILE)
  const summary = (await readOptional(summaryPath)).trim()
  let summaryUpdatedAt: string | null = null
  if (summary) {
    try {
      summaryUpdatedAt = (await stat(summaryPath)).mtime.toISOString()
    } catch {
      summaryUpdatedAt = null
    }
  }
  const lessons = parseLearnedLessons(await readOptional(join(root, LEARNED_LESSONS_FILE)))
  return { summary, summaryUpdatedAt, lessons }
}

/**
 * Removes one lesson. `text` must still match, so a lesson the agent added after the
 * user opened the list never shifts the deletion onto a different entry.
 */
export async function deleteLearnedLesson(
  root: string,
  index: number,
  text: string
): Promise<void> {
  const path = join(root, LEARNED_LESSONS_FILE)
  const raw = await readOptional(path)
  const lines = raw.split('\n')
  let seen = -1
  const position = lines.findIndex((line) => isLessonLine(line) && ++seen === index)
  if (position < 0 || lessonText(lines[position]) !== text) {
    throw new Error('这条经验已变化，请刷新后重试')
  }
  lines.splice(position, 1)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, lines.join('\n'), 'utf8')
  await rename(temporary, path)
}

/** Same delimiter stripping the SDK applies when it injects lessons. */
function neutralizeLesson(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[<>`]/g, '')
    .replace(/~{2,}/g, '~')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars))}\n…（已截断）`
}

/**
 * Prompt block for sessions whose SDK settings cwd is not the project memory root
 * (remote projects). Plain text only: `memory://` links would resolve on the wrong root.
 */
export function buildProjectMemoryPromptBlock(files: ProjectMemoryFiles): string | undefined {
  const summary = truncate(files.summary, PROMPT_BLOCK_MAX_CHARS)
  const lessonBudget = PROMPT_BLOCK_MAX_CHARS - summary.length
  const lessons =
    files.lessons.length > 0 && lessonBudget > 0
      ? truncate(
          files.lessons.map((lesson) => `- ${neutralizeLesson(lesson.text)}`).join('\n'),
          lessonBudget
        )
      : ''
  if (!summary && !lessons) return undefined
  const parts = [
    '# Project memory',
    'Notes from earlier conversations in this project. They can be stale: verify against the current files and the user before relying on them, and prefer the user and the repository when they disagree.'
  ]
  if (summary) parts.push(`Memory summary:\n${summary}`)
  if (lessons) parts.push(`Learned lessons:\n${lessons}`)
  return parts.join('\n\n')
}
