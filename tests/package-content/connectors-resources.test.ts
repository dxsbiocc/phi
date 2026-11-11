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
    'biorender',
    'BioRender',
    '搜索科学素材并制作科研插图',
    'BioRender',
    '设计创作',
    '需要登录',
    'https://mcp.services.biorender.com/mcp',
    'https://www.biorender.com'
  ],
  [
    'biorxiv',
    'bioRxiv',
    '检索 bioRxiv 与 medRxiv 预印本',
    'Anthropic',
    '健康与生命科学',
    '无需登录',
    'https://hcls.mcp.claude.com/biorxiv/mcp',
    'https://www.biorxiv.org'
  ],
  [
    'browser-use',
    'Browser Use',
    '让云端浏览器自动完成网页任务',
    'Browser Use',
    '生产力',
    '需要凭据',
    'https://api.browser-use.com/v3/mcp',
    'https://docs.browser-use.com/cloud/guides/mcp-server'
  ],
  [
    'cancer-omics',
    'Cancer omics',
    '检索 GDC、cBioPortal 和 PDC 的癌症组学数据',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/cancer/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'canva',
    'Canva',
    '在线搜索、创建设计并导出成品',
    'Canva',
    '设计创作',
    '需要登录',
    'https://mcp.canva.com/mcp',
    'https://www.canva.com'
  ],
  [
    'cbioportal',
    'cBioPortal',
    '查询癌症基因组研究、样本与临床数据',
    'cBioPortal',
    '健康与生命科学',
    '需要登录',
    'https://mcp.cbioportal.org/db/mcp',
    'https://docs.cbioportal.org/ai-integrations/mcp/'
  ],
  [
    'clinical-trials',
    'Clinical Trials',
    '检索 ClinicalTrials.gov 临床试验注册信息',
    'Anthropic',
    '健康与生命科学',
    '无需登录',
    'https://hcls.mcp.claude.com/clinical_trials/mcp',
    'https://clinicaltrials.gov'
  ],
  [
    'composio',
    'Composio Connect',
    '一个入口接入 1000+ 款常用应用',
    'Composio',
    '生产力',
    '需要登录',
    'https://connect.composio.dev/mcp',
    'https://docs.composio.dev/docs/composio-connect'
  ],
  [
    'epigenomics',
    'Epigenomics',
    '检索 ENCODE 与 Roadmap 表观基因组数据',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/epigenomics/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'excalidraw',
    'Excalidraw',
    '绘制并导出手绘风格示意图',
    'Excalidraw',
    '设计创作',
    '无需登录',
    'https://mcp.excalidraw.com/mcp',
    'https://github.com/excalidraw/excalidraw-mcp'
  ],
  [
    'figma',
    'Figma',
    '获取设计上下文并生成图表',
    'Figma',
    '设计创作',
    '需要登录',
    'https://mcp.figma.com/mcp',
    'https://www.figma.com'
  ],
  [
    'firecrawl',
    'Firecrawl',
    '抓取网页并提取结构化内容',
    'Firecrawl',
    '生产力',
    '需要凭据',
    'https://mcp.firecrawl.dev/v2/mcp',
    'https://docs.firecrawl.dev/mcp-server'
  ],
  [
    'linear',
    'Linear',
    '管理问题、项目与团队工作流',
    'Linear',
    '生产力',
    '需要登录',
    'https://mcp.linear.app/mcp',
    'https://linear.app'
  ],
  [
    'metabolomics',
    'Metabolomics',
    '检索 MetaboLights 代谢组学研究数据',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/metabolomics/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'notion',
    'Notion',
    '搜索、读取并整理工作区内容',
    'Notion',
    '生产力',
    '需要登录',
    'https://mcp.notion.com/mcp',
    'https://www.notion.so'
  ],
  [
    'ols4',
    'OLS4',
    '检索本体术语、层级与语义相似类',
    'EMBL-EBI',
    '健康与生命科学',
    '无需登录',
    'https://www.ebi.ac.uk/ols4/api/mcp',
    'https://www.ebi.ac.uk/ols4/mcp'
  ],
  [
    'open-targets',
    'Open Targets Platform',
    '检索靶点、疾病与药物关联证据',
    'Open Targets',
    '健康与生命科学',
    '无需登录',
    'https://mcp.platform.opentargets.org/mcp',
    'https://github.com/opentargets/platform-mcp'
  ],
  [
    'proteomics',
    'Proteomics',
    '检索 PRIDE 与 HPA 蛋白质组数据',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/proteomics/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'pubmed',
    'PubMed',
    '检索生物医学文献、摘要与开放全文',
    'Anthropic',
    '健康与生命科学',
    '无需登录',
    'https://pubmed.mcp.claude.com/mcp',
    'https://pubmed.ncbi.nlm.nih.gov'
  ],
  [
    'rcsb-mcp',
    'RCSB PDB',
    '检索 PDB 结构、配体与序列数据',
    'RCSB PDB',
    '健康与生命科学',
    '无需登录',
    'https://mcp-beta.rcsb.org/mcp',
    'https://github.com/rcsb/rcsb-mcp'
  ],
  [
    'serpapi',
    'SerpApi',
    '获取多个搜索引擎的实时结构化结果',
    'SerpApi',
    '生产力',
    '需要凭据',
    'https://mcp.serpapi.com/mcp',
    'https://serpapi.com/integrations/mcp'
  ],
  [
    'string-db',
    'STRING',
    '检索蛋白质互作、同源物与功能富集',
    'STRING',
    '健康与生命科学',
    '无需登录',
    'https://mcp.string-db.org/',
    'https://github.com/meringlab/string-mcp'
  ],
  [
    'tavily',
    'Tavily',
    '联网搜索并提取网页内容',
    'Tavily',
    '生产力',
    '需要凭据',
    'https://mcp.tavily.com/mcp',
    'https://github.com/tavily-ai/tavily-mcp'
  ],
  [
    'transcriptomics-single-cell',
    'Transcriptomics and single-cell',
    '检索 GTEx、CELLxGENE 等单细胞组学数据',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/transcriptomics/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ]
] as const

test('all distributed connector manifests are valid and preserve the featured catalog data', () => {
  const ids = readdirSync(connectorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const required of featuredMcpConnectors.map(([id]) => id)) {
    assert.ok(ids.includes(required), `connector ${required} must be distributed`)
  }
  assert.ok(!ids.includes('biomcp'), 'BioMCP must not be distributed in the built-in catalog')

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
