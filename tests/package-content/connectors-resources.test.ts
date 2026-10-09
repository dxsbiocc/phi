import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  readPackageManifest,
  validatePackage,
  type McpPackageManifest
} from '../../src/main/agent/packages/manifest'

import { packageContentPath } from '../helpers/packageContent'

const connectorsRoot = packageContentPath('connectors')
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
  ],
  [
    'composio',
    'Composio Connect',
    '通过一个连接入口使用已授权的第三方应用',
    'Composio',
    '生产力',
    '需要登录',
    'https://connect.composio.dev/mcp',
    'https://docs.composio.dev/docs/composio-connect'
  ],
  [
    'tavily',
    'Tavily',
    '联网搜索、提取网页内容并发现网站页面',
    'Tavily',
    '生产力',
    '需要凭据',
    'https://mcp.tavily.com/mcp',
    'https://github.com/tavily-ai/tavily-mcp'
  ],
  [
    'serpapi',
    'SerpApi',
    '检索多个搜索引擎的实时结构化结果',
    'SerpApi',
    '生产力',
    '需要凭据',
    'https://mcp.serpapi.com/mcp',
    'https://serpapi.com/integrations/mcp'
  ],
  [
    'firecrawl',
    'Firecrawl',
    '搜索、抓取和解析网页内容',
    'Firecrawl',
    '生产力',
    '需要凭据',
    'https://mcp.firecrawl.dev/v2/mcp',
    'https://docs.firecrawl.dev/mcp-server'
  ],
  [
    'browser-use',
    'Browser Use',
    '运行云端浏览器任务并查看执行结果',
    'Browser Use',
    '生产力',
    '需要凭据',
    'https://api.browser-use.com/v3/mcp',
    'https://docs.browser-use.com/cloud/guides/mcp-server'
  ],
  [
    'open-targets',
    'Open Targets Platform',
    '检索靶点、疾病、药物及其关联数据',
    'Open Targets',
    '健康与生命科学',
    '无需登录',
    'https://mcp.platform.opentargets.org/mcp',
    'https://github.com/opentargets/platform-mcp'
  ],
  [
    'cbioportal',
    'cBioPortal',
    '查询癌症基因组研究、样本、突变和临床数据',
    'cBioPortal',
    '健康与生命科学',
    '需要登录',
    'https://mcp.cbioportal.org/db/mcp',
    'https://docs.cbioportal.org/ai-integrations/mcp/'
  ]
] as const

test('all distributed connector manifests are valid and preserve the featured catalog data', () => {
  const ids = readdirSync(connectorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const required of [...featuredMcpConnectors.map(([id]) => id), 'biomcp']) {
    assert.ok(ids.includes(required), `connector ${required} must be distributed`)
  }

  const manifests = new Map<string, McpPackageManifest>()
  for (const id of ids) {
    const dir = join(connectorsRoot, id)
    const result = validatePackage(dir)
    assert.equal(result.ok, true, result.errors.map((problem) => problem.message).join('\n'))
    const manifest = readPackageManifest(dir)
    assert.equal(manifest.type, 'mcp')
    assert.equal(manifest.id, id)
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
          manifest.connector.transport === 'http'
            ? manifest.connector.auth === 'oauth'
              ? '需要登录'
              : manifest.connector.auth === 'header'
                ? '需要凭据'
                : '无需登录'
            : '本地服务',
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

test('BioMCP is distributed as a stdio connector with its package-relative launcher', () => {
  const manifest = readPackageManifest(join(connectorsRoot, 'biomcp')) as McpPackageManifest
  assert.equal(manifest.connector.transport, 'stdio')
  if (manifest.connector.transport !== 'stdio') return
  assert.equal(manifest.connector.environment, 'phi:python@1')
  assert.equal(manifest.connector.command, 'python')
  assert.deepEqual(manifest.connector.args, ['${package}/server.py'])
})
