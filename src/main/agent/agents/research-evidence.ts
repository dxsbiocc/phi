import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPathInsideRoot } from '../local-file-access'
import { parseAgentReport } from './report'

const UNVERIFIED =
  '<phi_agent_result>' +
  JSON.stringify({
    status: 'failed',
    research: {
      subquestion: 'Could the delegated result be verified?',
      answer: 'Insufficient evidence to report a verified result.',
      interpretation: 'The specialist could not substantiate the reported workspace artifacts.',
      rationale: 'Check the authorized workflow and its actual outputs before using a conclusion.',
      evidence: []
    }
  }) +
  '</phi_agent_result>'

const CORRECTION =
  'The claimed workspace evidence could not be verified. Recheck the original delegated task ' +
  'using the actual authorized tools. Return only findings supported by their results and exact ' +
  'verified references. If an input is needed, report it and its options. If you cannot verify a ' +
  'result, report the limitation. Do not invent counts, create placeholder evidence, restart an ' +
  'existing job, or expand the approved scope.'

// URLs, DOIs, versioned accessions, and catalog/source IDs can all contain a dot or slash.
// Use explicit ./ for extensionless workspace files to distinguish them from source IDs.
function workspacePath(reference: string): string | undefined {
  const ref = reference.trim()
  if (/^file:/i.test(ref)) {
    const url = new URL(ref)
    if (url.hostname && url.hostname !== 'localhost') return undefined
    return fileURLToPath(url)
  }
  if (/^\/\/|^\\\\/.test(ref)) return undefined
  if (win32.isAbsolute(ref) || isAbsolute(ref)) return ref
  if (/^[a-z][a-z0-9+.-]*:|^10\.\d{4,9}\//i.test(ref)) return undefined
  if (/^\.\.?[/\\]/.test(ref) || /\.[a-z][\w-]*$/i.test(ref)) return ref
  return undefined
}

async function filesVerified(cwd: string, paths: string[]): Promise<boolean> {
  try {
    const root = await realpath(cwd)
    for (const path of paths) {
      if (process.platform !== 'win32' && (path.includes('\\') || /^[a-z]:\//i.test(path)))
        return false
      const candidate = resolve(cwd, path)
      if (!isPathInsideRoot(cwd, candidate) && !isPathInsideRoot(root, candidate)) return false
      const actual = await realpath(candidate)
      if (!isPathInsideRoot(root, actual) || !(await stat(actual)).isFile()) return false
      await access(actual, constants.R_OK)
    }
    return true
  } catch {
    return false
  }
}

// Called inside the owning execution kernel while the child session is still alive. The
// desktop must never resolve an SSH workspace's paths in its own filesystem on replay.
export async function checkScientificCompletion(input: {
  cwd: string
  question: string
  text: string
  signal: AbortSignal
  toolActivity(): boolean
  successfulTool(): boolean
  correct(prompt: string): Promise<string>
}): Promise<string> {
  const inspect = async (text: string, correcting: boolean): Promise<boolean> => {
    const report = parseAgentReport(text, input.question)
    if (!report.structured || (!correcting && report.status !== 'completed')) return !correcting
    const { evidence } = JSON.parse(report.text) as { evidence: string[] }
    try {
      const paths = evidence.map(workspacePath).filter((ref): ref is string => ref !== undefined)
      return paths.length === 0 || filesVerified(input.cwd, paths)
    } catch {
      return false
    }
  }
  if (await inspect(input.text, false)) return input.text
  input.signal.throwIfAborted()
  // Never replay a child which attempted a tool: even a failed tool may already have written.
  if (input.toolActivity()) return UNVERIFIED
  const corrected = await input.correct(CORRECTION)
  input.signal.throwIfAborted()
  return input.successfulTool() && (await inspect(corrected, true)) ? corrected : UNVERIFIED
}
