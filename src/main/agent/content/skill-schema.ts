/**
 * Runtime source of truth for the `phi` block of Skill contract v1.
 * Args meta-rules (§ 5.1) are checked in code; they are not expressible cleanly here.
 */

export const SKILL_CONTRACT_VERSION = '1.0.0'

const scriptToolDeclarationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'run', 'args', 'approval'],
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' },
    description: { type: 'string', minLength: 1, maxLength: 1024 },
    run: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 }
    },
    args: { type: 'object' },
    approval: { type: 'string', enum: ['read', 'write'] },
    output: { type: 'string', pattern: '^\\./' },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 86400 }
  }
}

/** JSON Schema for the `phi` block (§ 2.2, § 5.1). */
export const phiSkillBlockSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'phi-skill-block.schema.json',
  title: 'Phi skill block',
  type: 'object',
  additionalProperties: false,
  properties: {
    environment: { type: 'string', minLength: 1 },
    attachTo: {
      type: 'array',
      items: { type: 'string', pattern: '^(main|[A-Z][A-Za-z0-9]*)$' }
    },
    toolPrefix: { type: 'string', pattern: '^[a-z][a-z0-9]{1,11}$' },
    scripts: {
      type: 'array',
      items: scriptToolDeclarationSchema
    }
  }
}
