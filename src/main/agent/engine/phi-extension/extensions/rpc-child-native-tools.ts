import { lstatSync, realpathSync, statSync } from 'node:fs'
import { extname, posix } from 'node:path'
import { resolveInsideProject } from '../lib/project-path'
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolInfo
} from '@oh-my-pi/pi-coding-agent'
import {
  createRpcChildCall,
  type RpcChildCall,
  type RpcChildScope
} from '../lib/rpc-child-protocol'

const textExtensions = new Set([
  '.txt',
  '.md',
  '.json',
  '.jsonl',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.r',
  '.sh',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.tsv',
  '.log',
  '.html',
  '.css',
  '.scss',
  '.sql',
  '.xml',
  '.ini',
  '.cfg',
  '.rst',
  '.tex'
])
/** R6a keeps unverified native URI/format/selector/path-alias capabilities closed. */
export function canonicalRpcChildNativeInput(
  cwd: string,
  name: string,
  input: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  if (
    (name === 'bash' || name === 'powershell') &&
    (input.async === true ||
      input.background === true ||
      Object.hasOwn(input, 'name') ||
      Object.hasOwn(input, 'ready'))
  )
    throw new Error('Phi child shell calls must remain owned synchronous executions')
  if (!['read', 'write', 'edit', 'glob', 'grep'].includes(name)) return { ...input }
  if (name === 'glob' || name === 'grep') {
    const raw = input.path ?? cwd
    if (
      typeof raw !== 'string' ||
      !raw ||
      /[:;,'"\\{}!()|\t\r\n]/u.test(raw) ||
      raw.split('/').includes('..') ||
      raw.normalize('NFC') !== raw.normalize('NFD')
    )
      throw new Error('Phi child search requires one exact project path or simple glob')
    const magic = raw.search(/[*?[]/u)
    let base = raw,
      suffix = ''
    if (magic >= 0) {
      if (/\s/u.test(raw)) throw new Error('Phi child search multi-path aliases are unavailable')
      const slash = raw.lastIndexOf('/', magic)
      base = slash < 0 ? cwd : raw.slice(0, slash) || '/'
      suffix = raw.slice(slash + 1)
    }
    const resolved = resolveInsideProject(cwd, base, 'Child search path')
    if (!resolved.ok) throw new Error('Phi child search path is outside the project')
    const target = realpathSync(resolved.path)
    return { ...input, path: suffix ? posix.join(target, suffix) : target }
  }
  const raw = input.path ?? (name === 'glob' || name === 'grep' ? cwd : undefined)
  const requested =
    name === 'read' && typeof raw === 'string' && raw.endsWith(':raw') ? raw.slice(0, -4) : raw
  if (
    typeof requested !== 'string' ||
    !requested ||
    /[:;?\\'\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(requested) ||
    requested.normalize('NFC') !== requested.normalize('NFD') ||
    [...requested].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Phi child file path is outside the verified native subset')
  const resolved = resolveInsideProject(cwd, requested, 'Child tool path')
  if (!resolved.ok) throw new Error('Phi child file path is outside the project')
  let target = resolved.path
  if (name === 'read' || name === 'edit') {
    target = realpathSync(target)
    if (!statSync(target).isFile() || !textExtensions.has(extname(target).toLowerCase()))
      throw new Error('Phi child read requires an existing ordinary text file')
    // These pinned SDK variants must collapse before adding the trusted raw selector.
    if (/ (AM|PM)\./u.test(target))
      throw new Error('Phi child read timestamp aliases are unverified')
    if (name === 'read')
      try {
        lstatSync(target + ':raw')
        throw new Error('Phi child raw selector collides with a literal path')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
  }
  if (
    /[:;?\\'\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(target) ||
    target.normalize('NFC') !== target.normalize('NFD')
  )
    throw new Error('Phi child canonical path has an unverified native spelling')
  return { ...input, path: name === 'read' ? target + ':raw' : target }
}

export interface RpcChildNativeExecution {
  readonly scope: RpcChildScope
  readonly signal: AbortSignal
  active(ctx: ExtensionContext): boolean
  canonical?(
    toolCallId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>
  ): Record<string, unknown>
  consume(toolCallId: string, toolName: string, input: unknown): RpcChildCall
  approve(call: RpcChildCall, signal: AbortSignal): Promise<boolean>
  revoke(): void
}

/** Keeps native implementations and schemas; only the attested execute path may bypass their no-UI approval tier. */
export function registerRpcChildNativeTools(
  pi: ExtensionAPI,
  tools: readonly ToolInfo[],
  nativeTool: AgentSession['getToolByName'],
  current: (ctx: ExtensionContext) => RpcChildNativeExecution | undefined
): ReadonlyMap<string, string> {
  const installed = new Map<string, string>()
  for (const tool of tools) {
    if (tool.sourceInfo.source !== 'builtin')
      throw new Error('RPC child needs an actual native tool')
    const native = nativeTool(tool.name)
    if (!native || native.name !== tool.name)
      throw new Error('RPC child native scheduling implementation is absent')
    const concurrency = native.concurrency
    const description = `Phi controlled native ${tool.name}. ${tool.description}`
    installed.set(tool.name, description)
    // Pinned registerTool's structural adapter forwards this public AgentTool metadata.
    const definition: ToolDefinition & Pick<typeof native, 'concurrency'> = {
      name: tool.name,
      label: tool.name,
      description,
      parameters: tool.parameters,
      concurrency: typeof concurrency === 'function' ? concurrency.bind(native) : concurrency,
      loadMode: 'essential',
      // The unconditional private authority exchange below owns approval, including read calls.
      approval: 'read',
      execute: async (toolCallId, input, signal, onUpdate, ctx) => {
        const binding = current(ctx)
        if (!binding || !binding.active(ctx) || !ctx.invokeTool)
          throw new Error('Phi child execution is unavailable')
        const combined = signal ? AbortSignal.any([signal, binding.signal]) : binding.signal
        try {
          combined.throwIfAborted()
          const initial = createRpcChildCall(binding.scope, toolCallId, tool.name, input)
          const effective = binding.canonical
            ? binding.canonical(toolCallId, tool.name, initial.input)
            : canonicalRpcChildNativeInput(binding.scope.cwd, tool.name, initial.input)
          const call = binding.consume(toolCallId, tool.name, effective)
          if (!(await binding.approve(call, combined)) || !binding.active(ctx))
            throw new Error('Phi child call was refused')
          combined.throwIfAborted()
          const after = createRpcChildCall(
            binding.scope,
            toolCallId,
            tool.name,
            createRpcChildCall(binding.scope, toolCallId, tool.name, input).input
          )
          const normalized =
            after.inputDigest === call.inputDigest
              ? after
              : createRpcChildCall(
                  binding.scope,
                  toolCallId,
                  tool.name,
                  binding.canonical
                    ? binding.canonical(toolCallId, tool.name, after.input)
                    : canonicalRpcChildNativeInput(binding.scope.cwd, tool.name, after.input)
                )
          if (normalized.inputDigest !== call.inputDigest)
            throw new Error('Phi child input changed during approval')
          // Execute an independent copy of precisely the approved canonical snapshot.
          const approvedInput = JSON.parse(JSON.stringify(call.input)) as Record<string, unknown>
          return await ctx.invokeTool(approvedInput, { signal: combined, onUpdate })
        } catch {
          binding.revoke()
          throw new Error('Phi child call was refused or interrupted')
        }
      }
    }
    pi.registerTool(definition)
  }
  return installed
}
