import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  readPackageManifest,
  validatePackage,
  type McpPackageManifest
} from '../src/main/agent/packages/manifest'

const connectorsRoot = resolve('resources/connectors')
const featuredMcpConnectors = [
  [
    'google-drive',
    'Google Drive',
    '搜索、读取和上传云端文件',
    'Google',
    '生产力',
    '需要登录',
    'https://drivemcp.googleapis.com/mcp/v1',
    'https://claude.com/marketplace/connectors/google-drive'
  ],
  [
    'notion',
    'Notion',
    '搜索、读取和整理工作区内容',
    'Notion',
    '生产力',
    '需要登录',
    'https://mcp.notion.com/mcp',
    'https://claude.com/marketplace/connectors/notion'
  ],
  [
    'linear',
    'Linear',
    '管理问题、项目和团队工作流',
    'Linear',
    '生产力',
    '需要登录',
    'https://mcp.linear.app/mcp',
    'https://claude.com/marketplace/connectors/linear'
  ],
  [
    'gmail',
    'Gmail',
    '搜索邮件、阅读会话并创建草稿',
    'Google',
    '沟通协作',
    '需要登录',
    'https://gmailmcp.googleapis.com/mcp/v1',
    'https://claude.com/marketplace/connectors/gmail'
  ],
  [
    'slack',
    'Slack',
    '搜索消息、频道和会话',
    'Slack',
    '沟通协作',
    '需要登录',
    'https://mcp.slack.com/mcp',
    'https://claude.com/marketplace/connectors/slack'
  ],
  [
    'figma',
    'Figma',
    '获取设计上下文和生成图表',
    'Figma',
    '设计创作',
    '需要登录',
    'https://mcp.figma.com/mcp',
    'https://claude.com/marketplace/connectors/figma'
  ],
  [
    'canva',
    'Canva',
    '搜索、创建和导出设计',
    'Canva',
    '设计创作',
    '需要登录',
    'https://mcp.canva.com/mcp',
    'https://claude.com/marketplace/connectors/canva'
  ],
  [
    'biorender',
    'BioRender',
    '搜索科学插图素材和生成科研图示',
    'BioRender',
    '设计创作',
    '需要登录',
    'https://mcp.services.biorender.com/mcp',
    'https://claude.com/marketplace/connectors/biorender'
  ],
  [
    'pubmed',
    'PubMed',
    '检索生物医学文献、摘要和可获取的 PMC 全文',
    'Anthropic',
    '健康与生命科学',
    '无需登录',
    'https://pubmed.mcp.claude.com/mcp',
    'https://claude.com/marketplace/connectors/pubmed'
  ],
  [
    'biorxiv',
    'bioRxiv',
    '检索 bioRxiv 和 medRxiv 预印本',
    'Anthropic',
    '健康与生命科学',
    '无需登录',
    'https://hcls.mcp.claude.com/biorxiv/mcp',
    'https://claude.com/marketplace/connectors/biorxiv'
  ],
  [
    'clinical-trials',
    'Clinical Trials',
    '检索 ClinicalTrials.gov 临床试验',
    'Anthropic',
    '健康与生命科学',
    '无需登录',
    'https://hcls.mcp.claude.com/clinical_trials/mcp',
    'https://claude.com/marketplace/connectors/clinical-trials'
  ]
] as const

test('all bundled connector manifests are valid and preserve the featured catalog data', () => {
  const ids = readdirSync(connectorsRoot).sort()
  assert.equal(ids.length, 11)
  assert.deepEqual(ids, featuredMcpConnectors.map(([id]) => id).sort())

  const manifests = new Map<string, McpPackageManifest>()
  for (const id of ids) {
    const dir = join(connectorsRoot, id)
    const result = validatePackage(dir)
    assert.equal(result.ok, true, result.errors.map((problem) => problem.message).join('\n'))
    const manifest = readPackageManifest(dir)
    assert.equal(manifest.type, 'mcp')
    assert.equal(manifest.id, id)
    assert.equal(manifest.version, '1.0.0')
    manifests.set(id, manifest as McpPackageManifest)
  }

  for (const [
    id,
    name,
    description,
    publisher,
    category,
    signIn,
    url,
    homepageUrl
  ] of featuredMcpConnectors) {
    const manifest = manifests.get(id)
    assert.ok(manifest, id)
    assert.deepEqual(
      {
        name: manifest.title,
        description: manifest.summary,
        publisher: manifest.connector.publisher,
        category: manifest.connector.category,
        signIn:
          manifest.connector.transport === 'http' && manifest.connector.auth === 'oauth'
            ? '需要登录'
            : '无需登录',
        url: manifest.connector.transport === 'http' ? manifest.connector.url : undefined,
        homepageUrl: manifest.connector.homepage
      },
      {
        name,
        description,
        publisher,
        category,
        signIn,
        url,
        homepageUrl
      },
      id
    )
  }
})
