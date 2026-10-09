/**
 * Runtime source of truth for the Environment contract v1.
 * `docs/contracts/environment.schema.json` and `docs/contracts/env-metadata.schema.json`
 * are published copies and must stay deep-equal to these objects.
 */

import { PHI_PLATFORMS as PHI_PLATFORM_IDS } from './platform'

function platformIdSchema(): object {
  return { type: 'string', enum: [...PHI_PLATFORM_IDS] }
}

const SHA256_PATTERN = '^[0-9a-f]{64}$(?![\\s\\S])'
const SAFE_MEMBER_PATTERN =
  '^(?!\\.\\.?(?:/|$))[A-Za-z0-9._+-]+(?:/(?!\\.\\.?(?:/|$))[A-Za-z0-9._+-]+)*$(?![\\s\\S])'
const HTTPS_ARTIFACT_PATTERN =
  '^https://(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::[0-9]{1,5})?(?:[/?][^\\s#]*)?$(?![\\s\\S])'

function executableSchema(): object {
  const reserved = [
    'python',
    'pythonw',
    'bun',
    'bunx',
    'pip',
    'node',
    'nodejs',
    'npm',
    'npx',
    'uv',
    'uvx',
    'conda',
    'mamba',
    'micromamba',
    'R',
    'Rscript'
  ].map((name) =>
    [...name].map((character) => `[${character.toLowerCase()}${character.toUpperCase()}]`).join('')
  )
  return {
    type: 'string',
    pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$(?![\\s\\S])',
    not: { pattern: `^(?:${reserved.join('|')})(?:[0-9]+(?:\\.[0-9]+)*)?$(?![\\s\\S])` }
  }
}

function nativeArtifactSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['url', 'sha256', 'size', 'format'],
    properties: {
      url: { type: 'string', pattern: HTTPS_ARTIFACT_PATTERN },
      sha256: { type: 'string', pattern: SHA256_PATTERN },
      size: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      format: { enum: ['file', 'tar.gz', 'zip'] },
      member: { type: 'string', pattern: SAFE_MEMBER_PATTERN }
    },
    allOf: [
      {
        if: { properties: { format: { const: 'file' } }, required: ['format'] },
        then: { not: { required: ['member'] } },
        else: { required: ['member'] }
      }
    ]
  }
}

function runtimeToolSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'artifacts'],
    properties: {
      version: {
        type: 'string',
        maxLength: 128,
        pattern:
          '^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$(?![\\s\\S])'
      },
      artifacts: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: Object.fromEntries(
          PHI_PLATFORM_IDS.map((platform) => [platform, nativeArtifactSchema()])
        )
      }
    }
  }
}

function applicationInstallationSchema(): object {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['backend', 'requirements', 'requirementsSha256', 'executable'],
        properties: {
          backend: { const: 'python-uv' },
          requirements: { type: 'string', pattern: `^\\./${SAFE_MEMBER_PATTERN.slice(1)}` },
          requirementsSha256: { type: 'string', pattern: SHA256_PATTERN },
          executable: executableSchema()
        }
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['backend', 'manifest', 'manifestSha256', 'lock', 'lockSha256', 'executable'],
        properties: {
          backend: { const: 'javascript-bun' },
          manifest: { const: './package.json' },
          manifestSha256: { type: 'string', pattern: SHA256_PATTERN },
          lock: { enum: ['./bun.lock', './package-lock.json'] },
          lockSha256: { type: 'string', pattern: SHA256_PATTERN },
          executable: executableSchema(),
          runtime: { enum: ['bun', 'node'] },
          bun: runtimeToolSchema(),
          node: runtimeToolSchema()
        },
        allOf: [
          {
            if: { required: ['node'] },
            then: { required: ['runtime'], properties: { runtime: { const: 'node' } } }
          }
        ]
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['backend', 'executable', 'artifacts'],
        properties: {
          backend: { const: 'native' },
          executable: executableSchema(),
          artifacts: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: Object.fromEntries(
              PHI_PLATFORM_IDS.map((platform) => [platform, nativeArtifactSchema()])
            )
          }
        }
      }
    ]
  }
}

function applicationInstallationMetadataSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['backend', 'executable', 'specSha256', 'artifacts'],
    properties: {
      backend: { enum: ['python-uv', 'javascript-bun', 'native'] },
      executable: { type: 'string', pattern: '^/[^\\u0000\\r\\n]+$(?![\\s\\S])' },
      specSha256: { type: 'string', pattern: SHA256_PATTERN },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'sha256', 'size'],
          properties: {
            key: { type: 'string', minLength: 1 },
            sha256: { type: 'string', pattern: SHA256_PATTERN },
            size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
          }
        }
      },
      installer: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'version'],
        properties: {
          name: { enum: ['bun', 'uv'] },
          version: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            pattern:
              '^[0-9]+(?:![0-9]+)?(?:\\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:\\.post[0-9]+)?(?:\\.dev[0-9]+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$(?![\\s\\S])'
          }
        }
      },
      packages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'version'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 214,
              pattern: '^(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+$(?![\\s\\S])'
            },
            version: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              pattern:
                '^[0-9]+(?:![0-9]+)?(?:\\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:\\.post[0-9]+)?(?:\\.dev[0-9]+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$(?![\\s\\S])'
            }
          }
        }
      }
    }
  }
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
      items: { type: 'string', minLength: 1 }
    },
    dependencies: {
      type: 'array',
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
    },
    installation: applicationInstallationSchema()
  },
  allOf: [
    {
      if: {
        required: ['installation'],
        properties: {
          installation: {
            anyOf: [
              { required: ['backend'], properties: { backend: { const: 'native' } } },
              {
                required: ['backend', 'bun'],
                properties: { backend: { const: 'javascript-bun' } },
                anyOf: [
                  { not: { required: ['runtime'], properties: { runtime: { const: 'node' } } } },
                  { required: ['runtime', 'node'], properties: { runtime: { const: 'node' } } }
                ]
              }
            ]
          }
        }
      },
      else: { properties: { channels: { minItems: 1 }, dependencies: { minItems: 1 } } }
    }
  ]
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
    runtimeEngine: { enum: ['micromamba', 'native'] },
    installation: applicationInstallationMetadataSchema(),
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
  },
  allOf: [
    {
      if: { properties: { runtimeEngine: { const: 'native' } }, required: ['runtimeEngine'] },
      then: {
        required: ['installation'],
        properties: {
          installation: {
            properties: { backend: { enum: ['native', 'javascript-bun'] } },
            required: ['backend']
          }
        }
      },
      else: { required: ['micromambaVersion'] }
    }
  ]
}
