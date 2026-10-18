import { isRecord } from './common'

/**
 * OMP 18.10.3 mounts discoverable tools as `xd://` devices driven through the ordinary
 * `read`/`write` tools: `read xd://` lists devices, `read xd://<tool>` documents one and
 * `write xd://<tool>` (JSON args in `content`) runs it. The outer `write` is only a transport.
 * OMP then re-dispatches the inner tool through its own extension wrapper, which emits a nested
 * `tool_call` for the inner tool with the SAME toolCallId. These helpers recognise the outer
 * transport call conservatively: only the exact canonical spellings are admitted, and any other
 * mention of the scheme is refused rather than guessed at (OMP trims, lower-cases and unwraps
 * several spellings before routing, so a looser parse could diverge from what OMP executes).
 */
const XD_MENTION = /xd:\/\//iu
const XD_DEVICE_PATH = /^xd:\/\/([a-zA-Z0-9_.-]{1,128})?$/u
const PATH_FIELDS = ['path', 'file_path'] as const
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'ast_edit', 'ast_grep'])

export type RpcXdevCall =
  /** `read xd://` or `read xd://<tool>`: listing or documentation, never executes a tool. */
  | { readonly kind: 'discovery' }
  /** `write xd://<tool>`: transport for the nested call of `<tool>`. */
  | { readonly kind: 'dispatch'; readonly name: string }
  /** Any other use of the scheme; must be blocked. */
  | { readonly kind: 'refused' }

function mentionsXdev(input: Record<string, unknown>): boolean {
  const values: unknown[] = [...PATH_FIELDS.map((key) => input[key]), input.cwd]
  if (Array.isArray(input.paths)) values.push(...input.paths)
  return values.some((value) => typeof value === 'string' && XD_MENTION.test(value))
}

/**
 * Classify a tool call that touches the `xd://` scheme. Returns undefined when the call has
 * nothing to do with it, so ordinary filesystem calls keep their existing handling untouched.
 */
export function classifyXdevCall(toolName: string, input: unknown): RpcXdevCall | undefined {
  if (!isRecord(input) || !PATH_TOOLS.has(toolName) || !mentionsXdev(input)) return undefined
  const path = input.path
  const match = typeof path === 'string' ? XD_DEVICE_PATH.exec(path) : null
  const keys = Object.keys(input)
  if (toolName === 'read' && match && keys.length === 1) return { kind: 'discovery' }
  if (
    toolName === 'write' &&
    match?.[1] &&
    typeof input.content === 'string' &&
    keys.every((key) => key === 'path' || key === 'content')
  )
    return { kind: 'dispatch', name: match[1] }
  return { kind: 'refused' }
}

/** True when a path argument is a canonical `xd://` device URL (never a filesystem location). */
export function isXdevDevicePath(path: string): boolean {
  return XD_DEVICE_PATH.test(path)
}
