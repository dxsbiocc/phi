/**
 * Runtime source of truth for the Environment contract v1.
 * `docs/contracts/environment.schema.json` and `docs/contracts/env-metadata.schema.json`
 * are published copies and must stay deep-equal to these objects.
 */

import { PHI_PLATFORMS as PHI_PLATFORM_IDS } from './platform'

function platformIdSchema(): object {
  return { type: 'string', enum: [...PHI_PLATFORM_IDS] }
}

function sourcePackageSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['language', 'name', 'source', 'ref', 'sha256'],
    properties: {
      language: { const: 'r' },
      name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.]*$' },
      source: { enum: ['cran', 'github'] },
      repo: { type: 'string' },
      ref: { type: 'string' },
      sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }
    },
    allOf: [
      {
        if: {
          properties: { source: { const: 'github' } },
          required: ['source']
        },
        then: {
          required: ['repo'],
          properties: {
            repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
            ref: { type: 'string', pattern: '^[0-9a-f]{40}$' }
          }
        }
      },
      {
        if: {
          properties: { source: { const: 'cran' } },
          required: ['source']
        },
        then: {
          not: { required: ['repo'] },
          properties: {
            ref: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+){1,3}(-[0-9]+)?$' }
          }
        }
      }
    ]
  }
}

export const environmentSpecSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'environment.schema.json',
  title: 'Phi environment spec',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'channels', 'dependencies'],
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}$' },
    channels: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 }
    },
    dependencies: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: [
          { type: 'string', minLength: 1 },
          {
            type: 'object',
            additionalProperties: false,
            required: ['pip'],
            properties: {
              pip: {
                type: 'array',
                items: { type: 'string', minLength: 1 }
              }
            }
          }
        ]
      }
    },
    description: { type: 'string' },
    host: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z0-9._+-]+$' },
          description: { type: 'string' },
          platforms: {
            type: 'array',
            items: platformIdSchema()
          },
          candidates: {
            type: 'array',
            items: { type: 'string', pattern: '^/.+' }
          }
        }
      }
    },
    sourcePackages: {
      type: 'array',
      items: sourcePackageSchema()
    }
  }
}

export const envMetadataSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'env-metadata.schema.json',
  title: 'Phi environment metadata',
  type: 'object',
  additionalProperties: false,
  required: [
    'envId',
    'name',
    'kind',
    'platform',
    'lockSha256',
    'createdAt',
    'micromambaVersion',
    'activation',
    'host',
    'sourcePackages',
    'status',
    'contractVersion'
  ],
  properties: {
    envId: { type: 'string', pattern: '^[a-z][a-z0-9-]*-[0-9a-f]{12}$' },
    name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}$' },
    kind: { enum: ['base', 'package', 'project'] },
    platform: platformIdSchema(),
    lockSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    createdAt: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$'
    },
    micromambaVersion: { type: 'string', minLength: 1 },
    activation: {
      type: 'object',
      additionalProperties: false,
      required: ['set', 'pathPrepend'],
      properties: {
        set: {
          type: 'object',
          additionalProperties: { type: 'string' }
        },
        pathPrepend: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    },
    host: {
      type: 'object',
      additionalProperties: { type: 'string', pattern: '^/.+' }
    },
    sourcePackages: {
      type: 'array',
      items: sourcePackageSchema()
    },
    status: { enum: ['absent', 'building', 'ready', 'failed', 'drifted'] },
    contractVersion: { type: 'string', pattern: '^1\\.\\d+\\.\\d+$' }
  }
}
