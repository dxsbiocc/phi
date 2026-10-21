import Ajv, { type ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import type { PhiTool } from '../types'
import { rpcRecord } from './control-frame'
import type { RpcHostToolDefinition } from './types'

const options = {
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false
} as const
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validDate(value: string): boolean {
  const match = datePattern.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}
const SERVER_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'glob',
  'ast_grep'
])
export interface RegisteredHostTool {
  tool: PhiTool
  definition: RpcHostToolDefinition
  validate: ValidateFunction
}

/** Snapshot metadata so later caller mutations cannot change the registered schema or executor. */
export function registeredHostTools(tools: readonly PhiTool[]): Map<string, RegisteredHostTool> {
  const registered = new Map<string, RegisteredHostTool>()
  // Schema IDs and references belong to this roster, never to another connection generation.
  const compilers = [new Ajv(options), new Ajv2020(options)]
  for (const compiler of compilers) {
    compiler.addFormat('input-path', true)
    compiler.addFormat('project-path', true)
    compiler.addFormat('date', { type: 'string', validate: validDate })
    compiler.addFormat('uuid', {
      type: 'string',
      validate: (value: string) => uuidPattern.test(value)
    })
  }

  for (const tool of tools) {
    if (
      !tool ||
      tool.site !== 'host' ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) ||
      registered.has(tool.name) ||
      SERVER_TOOLS.has(tool.name) ||
      typeof tool.label !== 'string' ||
      !tool.label.trim() ||
      typeof tool.description !== 'string' ||
      !tool.description.trim() ||
      typeof tool.execute !== 'function' ||
      !rpcRecord(tool.parameters) ||
      (tool.hidden !== undefined && typeof tool.hidden !== 'boolean') ||
      (tool.loadMode !== undefined && !['essential', 'discoverable'].includes(tool.loadMode))
    ) {
      throw new Error('Invalid or duplicate RPC host tool definition')
    }
    const parameters = structuredClone(tool.parameters)
    const compiler =
      parameters.$schema === 'https://json-schema.org/draft/2020-12/schema'
        ? compilers[1]
        : compilers[0]
    const validate = compiler.compile(parameters)
    const definition: RpcHostToolDefinition = {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters,
      ...(tool.hidden === undefined ? {} : { hidden: tool.hidden }),
      ...(tool.loadMode === undefined ? {} : { loadMode: tool.loadMode })
    }
    registered.set(tool.name, {
      tool: { ...tool, execute: tool.execute.bind(tool) },
      definition,
      validate
    })
  }
  return registered
}
