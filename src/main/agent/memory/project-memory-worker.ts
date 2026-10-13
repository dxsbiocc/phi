import { rm } from 'node:fs/promises'

import type { PhiTool } from '../engine/types'

import {
  closeMemoryDb,
  getAgentDbPath,
  getMemoryRoot,
  openMemoryDb,
  saveLearnedLesson
} from '../engine/omp-internals'

import { buildProjectLearnTool } from './learn-tool'
import {
  buildProjectMemoryPromptBlock,
  deleteLearnedLesson,
  readProjectMemoryFiles,
  type ProjectMemoryFiles
} from './project-memory-files'

// Worker-only (Bun): the SDK resolves memory paths and owns the SQLite state here.

export interface ProjectMemoryTarget {
  agentDir: string
  /** The session manager cwd: a local project directory or a remote project anchor. */
  cwd: string
}

function projectMemoryTarget(params: unknown): ProjectMemoryTarget {
  const record = (params ?? {}) as Record<string, unknown>
  if (typeof record.agentDir !== 'string' || !record.agentDir) throw new Error('缺少 agentDir')
  if (typeof record.cwd !== 'string' || !record.cwd) throw new Error('缺少项目记忆路径')
  return { agentDir: record.agentDir, cwd: record.cwd }
}

export async function readProjectMemory(params: unknown): Promise<ProjectMemoryFiles> {
  const target = projectMemoryTarget(params)
  return readProjectMemoryFiles(getMemoryRoot(target.agentDir, target.cwd))
}

export async function deleteProjectMemoryLesson(params: unknown): Promise<ProjectMemoryFiles> {
  const target = projectMemoryTarget(params)
  const record = params as Record<string, unknown>
  if (typeof record.index !== 'number' || !Number.isInteger(record.index) || record.index < 0) {
    throw new Error('经验序号无效')
  }
  if (typeof record.text !== 'string') throw new Error('经验内容无效')
  const root = getMemoryRoot(target.agentDir, target.cwd)
  await deleteLearnedLesson(root, record.index, record.text)
  return readProjectMemoryFiles(root)
}

/**
 * Clears one project. Unlike the SDK's `clearMemoryData`, other projects keep their
 * state, and the cleared conversations keep their stage-1 jobs marked done, so a later
 * startup does not summarize them again. Only conversations continued after the clear
 * feed the next summary.
 */
export async function clearProjectMemory(params: unknown): Promise<void> {
  const target = projectMemoryTarget(params)
  const db = openMemoryDb(getAgentDbPath(target.agentDir))
  try {
    db.transaction(() => {
      db.prepare(
        'DELETE FROM stage1_outputs WHERE thread_id IN (SELECT id FROM threads WHERE cwd = ?)'
      ).run(target.cwd)
      db.prepare("DELETE FROM jobs WHERE kind = 'memory_consolidate_global' AND job_key = ?").run(
        `global:${target.cwd}`
      )
    })()
  } finally {
    closeMemoryDb(db)
  }
  await rm(getMemoryRoot(target.agentDir, target.cwd), { recursive: true, force: true })
}

export function buildWorkerProjectLearnTool(target: ProjectMemoryTarget): PhiTool {
  return buildProjectLearnTool((input) =>
    saveLearnedLesson(target.agentDir, target.cwd, {
      content: input.content,
      ...(input.context ? { context: input.context } : {}),
      source: 'phi-learn',
      importance: 0.8
    })
  )
}

/** Read once at session start, like the SDK's own injection snapshot. */
export async function projectMemoryPromptBlock(
  target: ProjectMemoryTarget
): Promise<string | undefined> {
  return buildProjectMemoryPromptBlock(
    await readProjectMemoryFiles(getMemoryRoot(target.agentDir, target.cwd))
  )
}
