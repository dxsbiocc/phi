import type { ExtensionFactory, ToolDefinition } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionHost } from '../host'

const PLAN_STEPS_TOOL_NAME = 'propose_plan_steps'
const PLAN_SPEC_VERSION = 1
export const PLAN_MAX_STEPS = 20
export const PLAN_MAX_STEP_ID_LENGTH = 40
export const PLAN_MAX_STEP_TITLE_LENGTH = 80
export const PLAN_MAX_STEP_INSTRUCTIONS_LENGTH = 4_000
export const PLAN_MAX_STEP_ACCEPTANCE_LENGTH = 1_000

const stepSchema = {
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
      maxLength: PLAN_MAX_STEP_INSTRUCTIONS_LENGTH
    },
    acceptance: {
      type: 'string',
      minLength: 1,
      maxLength: PLAN_MAX_STEP_ACCEPTANCE_LENGTH
    },
    dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    access: { type: 'string', enum: ['read', 'write'] },
    writes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    agent: { type: 'string', minLength: 1 }
  }
}

const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'goal', 'steps'],
  properties: {
    version: { type: 'integer', const: PLAN_SPEC_VERSION },
    goal: { type: 'string', minLength: 1 },
    steps: { type: 'array', minItems: 1, maxItems: PLAN_MAX_STEPS, items: stepSchema }
  }
} as ToolDefinition['parameters']

export function createPlanStepsExtension(host: PhiExtensionHost): ExtensionFactory {
  return (pi) => {
    const definition: ToolDefinition & { lenientArgValidation: true } = {
      name: PLAN_STEPS_TOOL_NAME,
      label: 'Propose plan steps',
      description:
        'Submit the complete structured execution plan for user review. Use this exactly once the read-only investigation is sufficient. If validation fails, correct every reported error and submit again.',
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
