import type { PhiExtensionEnvironmentBinding } from '../host'
import { isRecord } from './common'

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface EnvironmentBinding extends PhiExtensionEnvironmentBinding {
  hostEnv?: Readonly<Record<string, string | undefined>>
}

export interface ToolCallRewrite {
  block?: boolean
  reason?: string
  input?: unknown
}

export function isReservedExecutionName(name: string): boolean {
  return (
    name === 'PATH' ||
    name.startsWith('PYTHON') ||
    name.startsWith('R_') ||
    name.startsWith('CONDA_') ||
    name.startsWith('MAMBA_') ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_') ||
    name.startsWith('PHI_ENV_')
  )
}

export function rewriteBoundBashInput(
  input: unknown,
  binding: EnvironmentBinding,
  hostEnvironment: Readonly<Record<string, string | undefined>> = binding.hostEnv ?? process.env
): Record<string, unknown> | undefined {
  if (binding.ref.length === 0) throw new Error('environment binding requires a ref')
  if (!isRecord(input) || typeof input.command !== 'string') return undefined
  const desired: Record<string, string> = { ...binding.variables }
  for (const [name, value] of Object.entries(explicitEnv(input.env))) {
    if (isReservedExecutionName(name)) continue
    desired[name] = value
  }
  const drop: string[] = []
  for (const name of Object.keys(hostEnvironment)) {
    if (!SHELL_NAME.test(name) || Object.hasOwn(desired, name)) continue
    drop.push(name)
  }
  drop.sort()
  const prefix = drop.length > 0 ? `unset -v ${drop.join(' ')}; ` : ''
  return { ...input, command: `${prefix}${input.command}`, env: desired }
}

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
