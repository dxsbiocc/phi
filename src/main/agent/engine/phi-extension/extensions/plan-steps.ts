import type { ExtensionFactory, ToolDefinition } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionHost } from '../host'

const PLAN_STEPS_TOOL_NAME = 'propose_plan_steps'
const PLAN_SPEC_VERSION = 1
export const PLAN_MAX_STEPS = 20
export const PLAN_MAX_STEP_ID_LENGTH = 40
export const PLAN_MAX_STEP_TITLE_LENGTH = 80
export const PLAN_MAX_STEP_INSTRUCTIONS_LENGTH = 4_000
export const PLAN_MAX_STEP_ACCEPTANCE_LENGTH = 1_000

const baseStepSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'instructions', 'acceptance', 'dependsOn', 'access'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: PLAN_MAX_STEP_ID_LENGTH,
      pattern: '^[a-z0-9-]+$'
    },
    title: { type: 'string', minLength: 1, maxLength: PLAN_MAX_STEP_TITLE_LENGTH },
    instructions: {
      type: 'string',
      minLength: 1,
      maxLength: PLAN_MAX_STEP_INSTRUCTIONS_LENGTH,
      description:
        'The commands, interpreters, and tools used here must be confirmed to exist in the environment during investigation (use check_environment).'
    },
    acceptance: {
      type: 'string',
      minLength: 1,
      maxLength: PLAN_MAX_STEP_ACCEPTANCE_LENGTH,
      description:
        'Describe how to check this step is done: name the file, command, or observable result and the rule it must satisfy (for example: file exists, has 30 lines, each line is the sum of the two before it, the script exits 0). Do not include values you have not computed and verified during investigation, such as counts, sums, or sequence terms worked out in your head; the step computes them. Any command, interpreter, or tool you name (for example python and python3) must be confirmed to exist in that environment during investigation (use check_environment); when unsure, state the result to check (file contents, a successful exit) instead of a specific command name.'
    },
    dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    access: { type: 'string', enum: ['read', 'write'] },
    writes: {
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
      description:
        'Project-relative paths this step writes. Absolute paths inside the project are accepted and stored relative.'
    },
    agent: {
      type: 'string',
      minLength: 1,
      description: 'Optional; normally omit it because Phi chooses the plan step agent.'
    }
  }
}

function planParameters(availableAgents: readonly string[]): ToolDefinition['parameters'] {
  const agentDescription =
    availableAgents.length > 0
      ? `Optional; normally omit it because Phi chooses the plan step agent. If set, use one of: ${availableAgents.join(', ')}.`
      : 'Optional; normally omit it because Phi chooses the plan step agent.'
  return {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'goal', 'steps'],
    properties: {
      version: { type: 'integer', const: PLAN_SPEC_VERSION },
      goal: { type: 'string', minLength: 1 },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: PLAN_MAX_STEPS,
        items: {
          ...baseStepSchema,
          properties: {
            ...baseStepSchema.properties,
            agent: { ...baseStepSchema.properties.agent, description: agentDescription }
          }
        }
      }
    }
  } as ToolDefinition['parameters']
}

export function createPlanStepsExtension(
  host: PhiExtensionHost,
  options: { availableAgents?: readonly string[] } = {}
): ExtensionFactory {
  const availableAgents = [
    ...new Set((options.availableAgents ?? []).filter((name) => name.trim()))
  ].sort((left, right) => left.localeCompare(right))
  const parameters = planParameters(availableAgents)
  return (pi) => {
    const definition: ToolDefinition & { lenientArgValidation: true } = {
      name: PLAN_STEPS_TOOL_NAME,
      label: 'Propose plan steps',
      description:
        'Submit the complete structured execution plan for user review. Use this exactly once the read-only investigation is sufficient. The agent field is optional and should normally be omitted because Phi picks the plan step agent. Writes are project-relative paths. If validation fails, correct every reported error and submit again. Acceptance must state how to check the result, not unverified values or commands.',
      parameters,
      defaultInactive: true,
      loadMode: 'essential',
      approval: 'read',
      strict: true,
      lenientArgValidation: true,
      execute: async (_toolCallId, input) => {
        if (!host.planExecuteModeActive()) {
          return {
            content: [{ type: 'text', text: 'Plan execution mode is not active.' }],
            isError: true
          }
        }
        return host.proposePlanSteps(input)
      }
    }
    pi.registerTool(definition)
  }
}
