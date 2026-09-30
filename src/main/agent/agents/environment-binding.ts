import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { isReservedExecutionName } from '../envs/reserved-names'

export { isReservedExecutionName }

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface EnvironmentBinding {
  ref: string
  variables: Record<string, string>
  /** Defaults to the worker's live `process.env` (the object, read at rewrite time). */
  hostEnv?: NodeJS.ProcessEnv
}

export interface ToolCallRewrite {
  block?: boolean
  reason?: string
  input?: unknown
}

/**
 * omp's bash `env` does not replace the worker environment. `executeBash`
 * folds it through `buildNonInteractiveEnv` into `Shell.run`, whose `env` is
 * applied for that command only: a direct `Shell.run` kept an inherited
 * `PHI_TEST_HOST_SECRET` while overriding `PATH`. The pty path does the same
 * overlay (bash-interactive: the native side applies `env` as overrides).
 *
 * Prefixing `unset -v` drops host names that are not in the bound set inside
 * the shell that runs the command, so builtins such as `command -v` see the
 * environment PATH. `env -i` would only clean a child of the shell. pty and
 * async bash both execute this command string, so the same rewrite covers them.
 */
export function rewriteBoundBashInput(
  input: unknown,
  binding: EnvironmentBinding
): Record<string, unknown> | undefined {
  if (binding.ref.length === 0) throw new Error('environment binding requires a ref')
  if (!isRecord(input) || typeof input.command !== 'string') return undefined
  const desired: Record<string, string> = { ...binding.variables }
  for (const [name, value] of Object.entries(explicitEnv(input.env))) {
    if (isReservedExecutionName(name)) continue
    desired[name] = value
  }
  const host = binding.hostEnv ?? process.env
  const drop: string[] = []
  for (const name of Object.keys(host)) {
    if (!SHELL_NAME.test(name) || Object.hasOwn(desired, name)) continue
    drop.push(name)
  }
  drop.sort()
  const prefix = drop.length > 0 ? `unset -v ${drop.join(' ')}; ` : ''
  return {
    ...input,
    command: `${prefix}${input.command}`,
    env: desired
  }
}

export function createEnvironmentBindingExtension({
  ref,
  variables,
  hostEnv = process.env
}: EnvironmentBinding): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName !== 'bash') return undefined
      const input = rewriteBoundBashInput(event.input, { ref, variables, hostEnv })
      return input ? { input } : undefined
    })
  }
}

/**
 * omp `ExtensionRunner.emitToolCall`: every handler sees the original event,
 * not an earlier handler's rewrite. The last non-empty result wins. A
 * `{ block: true }` result returns immediately, so later handlers do not run.
 * Approval and the plan-mode guard must be registered before the binding so
 * the approval card shows the command the model wrote and the binding's
 * rewritten input is the one that executes.
 */
export async function reduceToolCallResults(
  event: { toolName: string; input: unknown },
  handlers: readonly ((event: {
    toolName: string
    input: unknown
  }) => ToolCallRewrite | undefined | Promise<ToolCallRewrite | undefined>)[]
): Promise<ToolCallRewrite | undefined> {
  let result: ToolCallRewrite | undefined
  for (const handler of handlers) {
    const handlerResult = await handler(event)
    if (!handlerResult) continue
    result = handlerResult
    if (result.block) return result
  }
  return result
}

function explicitEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const env: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string') env[name] = item
  }
  return env
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
