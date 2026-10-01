/**
 * Runtime source of truth for Plugin contract v1.
 * `docs/contracts/plugin.schema.json` is the published copy and must stay
 * deep-equal to this object.
 */

export const PLUGIN_CONTRACT_VERSION = '1.0.0'

export const pluginManifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://phi.local/contracts/plugin.schema.json',
  title: 'Phi plugin manifest (phi-package.yaml, type: plugin)',
  description:
    'Plugin contract 1.0.0 (docs/contracts/plugin.md). Path existence, cross-component rules, uniqueness, and reserved prefixes are enforced in code.',
  type: 'object',
  required: [
    'schemaVersion',
    'id',
    'type',
    'version',
    'title',
    'summary',
    'toolPrefix',
    'components'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
    type: { const: 'plugin' },
    version: {
      type: 'string',
      pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
    },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    summary: { type: 'string', minLength: 1, maxLength: 300 },
    toolPrefix: { type: 'string', pattern: '^[a-z][a-z0-9]{1,11}$' },
    components: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string', pattern: '^agents/[A-Z][A-Za-z0-9]*\\.md$' },
          uniqueItems: true
        },
        skills: {
          type: 'array',
          items: { type: 'string', pattern: '^skills/[a-z0-9][a-z0-9-]{0,63}$' },
          uniqueItems: true
        }
      }
    },
    environments: {
      type: 'object',
      propertyNames: { pattern: '^[a-z][a-z0-9-]{0,62}$' },
      additionalProperties: {
        type: 'object',
        required: ['spec'],
        additionalProperties: false,
        properties: {
          spec: {
            type: 'string',
            pattern: '^environments/[a-z][a-z0-9-]{0,62}/environment\\.yml$'
          }
        }
      }
    }
  }
}

export interface PhiPluginComponents {
  agents?: string[]
  skills?: string[]
}

export interface PhiPluginEnvironmentDeclaration {
  spec: string
}

export interface PhiPluginManifest {
  schemaVersion: 1
  id: string
  type: 'plugin'
  version: string
  title: string
  summary: string
  toolPrefix: string
  components: PhiPluginComponents
  environments?: Record<string, PhiPluginEnvironmentDeclaration>
}
