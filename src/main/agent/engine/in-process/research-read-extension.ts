import { existsSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, matchesGlob, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenizeShellSegments } from '@oh-my-pi/pi-coding-agent/tools/shell-tokenize'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { isPathInsideRoot } from '../../local-file-access'
import { isRecord } from '../../../../shared/guards'
import type { AgentRunRegistry } from '../../agents/registry'
import { authoredUserText } from '../tool-adapter'

const TABLE_OR_LOG = /\.(?:tsv|csv|tab|jsonl|ndjson|log|stderr|stdout)(?:\.gz)?$/i

function delegationCallsSinceUser(branch: readonly unknown[]): Set<string> {
  const ids = new Set<string>()
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) continue
    const message = entry.message
    if (authoredUserText(message) !== undefined) break
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string')
      ids.add(message.toolCallId)
  }
  return ids
}

function localPath(cwd: string, reference: string): string | undefined {
  try {
    let path = reference
    if (/^file:/i.test(path)) {
      const url = new URL(path)
      if (url.host && url.host !== 'localhost') return undefined
      path = fileURLToPath(url)
    }
    if (/^(?:\/\/|\\\\)/.test(path)) return undefined
    if (!isAbsolute(path) && /^[a-z][a-z\d+.-]*:/i.test(path)) return undefined
    const absolute = resolve(cwd, path)
    return isPathInsideRoot(cwd, absolute) || isPathInsideRoot(realpathSync(cwd), absolute)
      ? absolute
      : undefined
  } catch {
    return undefined
  }
}

function canonical(cwd: string, reference: string): string | undefined {
  const path = localPath(cwd, reference)
  if (!path) return undefined
  try {
    const actual = realpathSync(path)
    return isPathInsideRoot(realpathSync(cwd), actual) ? actual : undefined
  } catch {
    return path
  }
}

function wholeReadPaths(cwd: string, value: string): Set<string | undefined> {
  // Native read prefers literal filenames before inline selectors and multi-path recovery.
  const path = value.trim()
  const literal = localPath(cwd, path)
  if (literal && existsSync(literal)) return new Set([canonical(cwd, path)])
  // Commas between range chunks are selectors on one file, not separate requests.
  const parts = path.split(/;|,(?!\s*L?\d+(?:(?:[-+]|\.\.)L?\d*)?\s*(?:,|:raw|;|$))/i)
  const references = [path, ...parts, ...parts.flatMap((part) => part.split(/\s+/))]
  // A lone :1 (also :L1, :1-, :1..) reads from line one to EOF in OMP.
  const wholeSelector = /:(?:raw(?::L?0*1(?:-|\.\.)?)?|L?0*1(?:-|\.\.)?(?::raw)?)$/i
  return new Set(references.map((ref) => canonical(cwd, ref.trim().replace(wholeSelector, ''))))
}

const PREVIEW_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'cut',
  'column',
  'more',
  'less',
  'type',
  'get-content',
  'gc'
])

function previewInputs(directory: string, args: string[]): string[] {
  const inputs: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const redirect = /^(\d*)>>?(.*)$/.exec(arg)
    if (redirect) {
      const destination = redirect[2] || args[++index]
      if (
        destination &&
        (!redirect[1] || redirect[1] === '1') &&
        !/^(?:&|\/dev\/(?:std(?:err|out)|tty|fd\/)|\/proc\/.*\/fd\/)/.test(destination)
      )
        return []
      continue
    }
    if (arg === '<' || arg.startsWith('-')) continue
    inputs.push(resolve(directory, arg.replace(/^</, '')))
  }
  return inputs
}

function shellPreviewPaths(cwd: string, command: string): string[] {
  let directory = cwd
  const reads: string[] = []
  for (const segment of tokenizeShellSegments(command)) {
    let words = segment
    if (words[0] === 'command' || words[0] === 'builtin') words = words.slice(1)
    if (/^cmd(?:\.exe)?$/i.test(words[0]) && /^\/c$/i.test(words[1])) words = words.slice(2)
    const name = basename(words[0] ?? '').toLowerCase()
    const args = words.slice(1)
    if (name === 'cd' && args.length === 1) {
      directory = resolve(directory, args[0])
      continue
    }
    if (!PREVIEW_COMMANDS.has(name)) continue
    reads.push(...previewInputs(directory, args))
  }
  return reads
}

function findingNotice(
  reference: string,
  finding: { answer: string; interpretation: string }
): string {
  return [
    `The specialist already reported this artifact: ${reference}.`,
    finding.answer,
    finding.interpretation,
    'Deliver from these verified findings and link the artifact with present_files. If a value needed for the original question is missing, ask the specialist for that value.'
  ].join(' ')
}

export function researchReadNotice(
  cwd: string,
  requested: string,
  branch: readonly unknown[],
  registry: Pick<AgentRunRegistry, 'researchFindings'>,
  shellDirectory?: string
): string | undefined {
  const calls = delegationCallsSinceUser(branch)
  if (!calls.size) return undefined
  const findings = registry.researchFindings(calls)
  if (!findings.length) return undefined
  const shellReads = shellDirectory ? shellPreviewPaths(shellDirectory, requested) : undefined
  const reads = shellReads
    ? new Set(shellReads.map((path) => canonical(cwd, path)))
    : wholeReadPaths(cwd, requested)
  for (const finding of findings) {
    for (const reference of finding.evidence) {
      if (!TABLE_OR_LOG.test(reference)) continue
      const path = canonical(cwd, reference)
      if (
        path &&
        (reads.has(path) ||
          shellReads?.some(
            (pattern) => /[?*[]/.test(pattern) && matchesGlob(resolve(cwd, reference), pattern)
          ))
      ) {
        return findingNotice(reference, finding)
      }
    }
  }
  return undefined
}

function shellRequest(
  name: string,
  input: unknown,
  cwd: string
): { directory: string; command: string } | undefined {
  if (
    (name !== 'bash' && name !== 'powershell') ||
    !isRecord(input) ||
    typeof input.command !== 'string'
  )
    return undefined
  return {
    command: input.command,
    directory: typeof input.cwd === 'string' ? resolve(cwd, input.cwd) : cwd
  }
}

/** Resolve before read execution. For shell previews keep command effects and withhold both live and final output. */
export function createResearchReadExtension(registry: AgentRunRegistry): ExtensionFactory {
  return (pi) => {
    const shellNotices = new Map<string, string>()
    const wrapped = new WeakSet<object>()
    pi.on('agent_end', () => {
      shellNotices.clear()
    })
    pi.on('tool_call', (event, ctx) => {
      if (ctx.agent.kind !== 'main') return
      if (event.toolName === 'read' && typeof event.input.path === 'string') {
        const reason = researchReadNotice(
          ctx.cwd,
          event.input.path,
          ctx.sessionManager.getBranch(),
          registry
        )
        return reason ? { block: true, reason } : undefined
      }
      const shell = shellRequest(event.toolName, event.input, ctx.cwd)
      if (!shell) return
      const notice = researchReadNotice(
        ctx.cwd,
        shell.command,
        ctx.sessionManager.getBranch(),
        registry,
        shell.directory
      )
      if (!notice) return
      const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
      const tool = session?.getToolByName(event.toolName)
      if (!session || session.sessionManager !== ctx.sessionManager || !tool)
        return { block: true, reason: notice }
      if (!wrapped.has(tool)) {
        const original = tool.execute
        tool.execute = async function (id, args, signal, onUpdate, context) {
          const summary = shellNotices.get(id)
          if (!summary) return original.call(this, id, args, signal, onUpdate, context)
          shellNotices.delete(id)
          try {
            const result = await original.call(this, id, args, signal, undefined, context)
            const exitCode =
              isRecord(result.details) && typeof result.details.exitCode === 'number'
                ? result.details.exitCode
                : undefined
            const outcome = result.isError
              ? `The shell command failed${exitCode === undefined ? '' : ` (exit ${exitCode})`}.`
              : 'The shell command ran.'
            return {
              content: [{ type: 'text', text: outcome + ' ' + summary }],
              ...(exitCode !== undefined ? { details: { exitCode } } : {}),
              ...(result.isError ? { isError: true } : {})
            }
          } catch {
            signal?.throwIfAborted()
            throw new Error('The shell command failed. ' + summary)
          }
        }
        wrapped.add(tool)
      }
      shellNotices.set(event.toolCallId, notice)
      return undefined
    })
  }
}
