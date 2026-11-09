import { tmpdir } from 'node:os'
import type { ExtensionFactory, ToolDefinition } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionHost } from '../host'
import {
  defaultProbeRunner,
  defaultShellEnvironment,
  formatResult,
  runCheckEnvironment,
  selectedEnvironment,
  type CheckEnvironmentDetails,
  type ProbeRunner,
  type ShellEnvironment
} from '../lib/check-environment'

export const CHECK_ENVIRONMENT_TOOL_NAME = 'check_environment'

const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const PYTHON_MODULE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
const R_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9.]{0,63}$/
const MAX_ITEMS = 20

interface CheckEnvironmentInput {
  commands: string[]
  python_modules: string[]
  r_packages: string[]
}

const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commands: {
      type: 'array',
      maxItems: MAX_ITEMS,
      uniqueItems: true,
      description:
        'Executables to resolve on PATH, for example python3, Rscript, samtools, or bwa.',
      items: { type: 'string', pattern: COMMAND_PATTERN.source }
    },
    python_modules: {
      type: 'array',
      maxItems: MAX_ITEMS,
      uniqueItems: true,
      description:
        'Python modules or dotted module names to check, for example numpy or scipy.stats.',
      items: { type: 'string', pattern: PYTHON_MODULE_PATTERN.source }
    },
    r_packages: {
      type: 'array',
      maxItems: MAX_ITEMS,
      uniqueItems: true,
      description: 'R packages to check, for example stats or DESeq2.',
      items: { type: 'string', pattern: R_PACKAGE_PATTERN.source }
    }
  }
} as ToolDefinition['parameters']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringItems(
  value: unknown,
  key: keyof CheckEnvironmentInput,
  pattern: RegExp,
  errors: string[]
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array of strings`)
    return []
  }
  if (value.length > MAX_ITEMS) errors.push(`${key} must contain at most ${MAX_ITEMS} items`)
  const seen = new Set<string>()
  const items: string[] = []
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !pattern.test(item)) {
      errors.push(`${key}[${index}] must match ${pattern.source}`)
      return
    }
    if (seen.has(item)) {
      errors.push(`${key}[${index}] duplicates "${item}"`)
      return
    }
    seen.add(item)
    items.push(item)
  })
  return items
}

function parseInput(
  value: unknown
): { ok: true; input: CheckEnvironmentInput } | { ok: false; errors: string[] } {
  if (!isRecord(value)) return { ok: false, errors: ['arguments must be an object'] }
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (key !== 'commands' && key !== 'python_modules' && key !== 'r_packages') {
      errors.push(`unknown property "${key}"`)
    }
  }
  const commands = stringItems(value.commands, 'commands', COMMAND_PATTERN, errors)
  const python_modules = stringItems(
    value.python_modules,
    'python_modules',
    PYTHON_MODULE_PATTERN,
    errors
  )
  const r_packages = stringItems(value.r_packages, 'r_packages', R_PACKAGE_PATTERN, errors)
  if (commands.length === 0 && python_modules.length === 0 && r_packages.length === 0) {
    errors.push('at least one of commands, python_modules, or r_packages must be non-empty')
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, input: { commands, python_modules, r_packages } }
}

export function createCheckEnvironmentExtension(
  host: PhiExtensionHost,
  options: { runner?: ProbeRunner; cwd?: string; shellEnvironment?: ShellEnvironment } = {}
): ExtensionFactory {
  const runner = options.runner ?? defaultProbeRunner
  const cwd = options.cwd ?? tmpdir()
  const shellEnvironment = options.shellEnvironment ?? defaultShellEnvironment
  return (pi) => {
    const definition: ToolDefinition<typeof parameters, CheckEnvironmentDetails> & {
      lenientArgValidation: true
    } = {
      name: CHECK_ENVIRONMENT_TOOL_NAME,
      label: 'Check environment',
      description:
        'Read-only check of which commands, Python modules, and R packages exist in the environment that plan steps will run in. Use it while planning instead of a shell or globbing system paths; it never installs or changes anything.',
      parameters,
      defaultInactive: true,
      loadMode: 'essential',
      approval: 'read',
      strict: true,
      lenientArgValidation: true,
      execute: async (_toolCallId, input) => {
        const parsed = parseInput(input)
        if (!parsed.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid check_environment input:\n${parsed.errors.join('\n')}`
              }
            ],
            details: { commands: [] },
            isError: true
          }
        }
        const selection = await selectedEnvironment(host, cwd, shellEnvironment)
        const details = await runCheckEnvironment(
          parsed.input,
          selection.environment,
          cwd,
          runner,
          selection
        )
        return { content: [{ type: 'text', text: formatResult(details) }], details }
      }
    }
    pi.registerTool(definition)
  }
}
