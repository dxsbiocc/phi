import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from 'node:fs'
import { join } from 'node:path'

export const RPC_PLAN_DRAFT_URL = 'local://PLAN.md'
export const RPC_PLAN_DRAFT_MAX_BYTES = 64 * 1024

type DraftSession = {
  getArtifactsDir(): string | null
}

function proposalTitle(input: unknown): string {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, 'title')
  )
    throw new Error('Plan proposal accepts a title only')
  const title = (input as { title: unknown }).title
  if (
    typeof title !== 'string' ||
    title !== title.trim() ||
    !title ||
    Array.from(title).length > 120 ||
    [...title].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    throw new Error('Plan proposal title is invalid')
  return title
}

function readSessionDraft(session: DraftSession): string {
  const artifacts = session.getArtifactsDir()
  if (!artifacts) throw new Error('Session plan artifacts are unavailable')
  // SDK 18.10.3 resolveLocalRoot uses <artifacts>/local on the Unix SSH hosts.
  // The session manager, not model input, supplies this artifact directory.
  const root = join(artifacts, 'local')
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root)
    throw new Error('Session plan draft root is unavailable')
  const path = join(root, 'PLAN.md')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < 1 || before.size > RPC_PLAN_DRAFT_MAX_BYTES)
      throw new Error('Session plan draft is empty or too large')
    const bytes = Buffer.alloc(before.size)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(fd)
    const pathStat = lstatSync(path)
    if (
      length !== before.size ||
      !pathStat.isFile() ||
      [after, pathStat].some(
        (stat) =>
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== before.size ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs
      )
    )
      throw new Error('Session plan draft changed during review')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!content.trim() || content.includes('\0'))
      throw new Error('Session plan draft is not valid Markdown text')
    return content
  } finally {
    closeSync(fd)
  }
}

/** Refuse pre-existing links and special files before SDK local:// write/edit routing. */
export function assertRpcPlanDraftMutationTarget(session: DraftSession): void {
  const artifacts = session.getArtifactsDir()
  if (!artifacts || !lstatSync(artifacts).isDirectory() || realpathSync(artifacts) !== artifacts)
    throw new Error('Session plan artifacts are unavailable')
  const root = join(artifacts, 'local')
  let rootExists = false
  try {
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || realpathSync(root) !== root)
      throw new Error('Session plan draft root is unsafe')
    rootExists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!rootExists) return
  try {
    if (!lstatSync(join(root, 'PLAN.md')).isFile())
      throw new Error('Session plan draft target is unsafe')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Read only the current OMP session's plan artifact; model input never selects a file. */
export function rpcMarkdownPlanProposal(
  session: DraftSession,
  input: unknown
): { title: string; content: string; planFilePath: typeof RPC_PLAN_DRAFT_URL } {
  const title = proposalTitle(input)
  const content = readSessionDraft(session)
  return { title, content, planFilePath: RPC_PLAN_DRAFT_URL }
}

/** SDK 18.10.3 passes one event input to every handler, then applies the last rewrite. */
export function bindRpcMarkdownPlanProposal(
  session: DraftSession,
  input: unknown
): ReturnType<typeof rpcMarkdownPlanProposal> {
  const proposal = rpcMarkdownPlanProposal(session, input)
  if (!input || typeof input !== 'object' || !Object.isExtensible(input))
    throw new Error('Plan proposal input cannot be signed')
  Object.assign(input, proposal)
  if (
    (input as Record<string, unknown>).content !== proposal.content ||
    (input as Record<string, unknown>).planFilePath !== RPC_PLAN_DRAFT_URL
  )
    throw new Error('Plan proposal input could not be bound to the draft')
  return proposal
}
