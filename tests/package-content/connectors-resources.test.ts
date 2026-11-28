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
    'Search biomedical icons and templates to build scientific figures in BioRender',
    'BioRender',
    '设计创作',
    '需要登录',
    'https://mcp.services.biorender.com/mcp',
    'https://www.biorender.com'
  ],
  [
    'biorxiv',
    'bioRxiv & medRxiv',
    'Search and browse bioRxiv and medRxiv life-science preprints, version histories, and peer-reviewed journal links',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/biorxiv/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'browser-use',
    'Browser Use',
    'Automate multi-step web browsing, form submission, and page extraction in a cloud browser',
    'Browser Use',
    '生产力',
    '需要凭据',
    'https://api.browser-use.com/v3/mcp',
    'https://docs.browser-use.com/cloud/guides/mcp-server'
  ],
  [
    'cancer-omics',
    'Cancer Omics',
    'Query open cancer genomics and proteomics metadata across NCI GDC, cBioPortal, and PDC',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/cancer/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'canva',
    'Canva',
    'Search templates, create and resize visual designs, and export finished assets in Canva',
    'Canva',
    '设计创作',
    '需要登录',
    'https://mcp.canva.com/mcp',
    'https://www.canva.com'
  ],
  [
    'cbioportal',
    'cBioPortal',
    'Explore cancer genomics studies, patient cohorts, somatic mutations, and clinical attributes',
    'cBioPortal',
    '健康与生命科学',
    '需要登录',
    'https://mcp.cbioportal.org/db/mcp',
    'https://docs.cbioportal.org/ai-integrations/mcp/'
  ],
  [
    'clinical-trials',
    'Clinical Trials',
    'Search ClinicalTrials.gov study protocols, eligibility criteria, interventions, endpoints, and posted trial results',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/clinical-trials/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'composio',
    'Composio Connect',
    'Connect to 1,000+ SaaS tools and developer apps through a single managed MCP endpoint',
    'Composio',
    '生产力',
    '需要登录',
    'https://connect.composio.dev/mcp',
    'https://docs.composio.dev/docs/composio-connect'
  ],
  [
    'epigenomics',
    'Epigenomics',
    'Search ENCODE and Roadmap Epigenomics experiments, files, and biosample metadata',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/epigenomics/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'excalidraw',
    'Excalidraw',
    'Create, edit, and export hand-drawn flowcharts, architecture diagrams, and sketches',
    'Excalidraw',
    '设计创作',
    '无需登录',
    'https://mcp.excalidraw.com/mcp',
    'https://github.com/excalidraw/excalidraw-mcp'
  ],
  [
    'figma',
    'Figma',
    'Inspect Figma frames, components, and layout specs or generate diagrams in FigJam',
    'Figma',
    '设计创作',
    '需要登录',
    'https://mcp.figma.com/mcp',
    'https://www.figma.com'
  ],
  [
    'firecrawl',
    'Firecrawl',
    'Scrape web pages, crawl entire sites, and extract clean Markdown or structured data',
    'Firecrawl',
    '生产力',
    '需要凭据',
    'https://mcp.firecrawl.dev/v2/mcp',
    'https://docs.firecrawl.dev/mcp-server'
  ],
  [
    'linear',
    'Linear',
    'Search, create, and update issues, projects, cycles, and team workflows in Linear',
    'Linear',
    '生产力',
    '需要登录',
    'https://mcp.linear.app/mcp',
    'https://linear.app'
  ],
  [
    'metabolomics',
    'Metabolomics',
    'Browse EMBL-EBI MetaboLights study, assay, and file metadata for open metabolomics datasets',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/metabolomics/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'notion',
    'Notion',
    'Search, read, create, and organize pages and databases across a Notion workspace',
    'Notion',
    '生产力',
    '需要登录',
    'https://mcp.notion.com/mcp',
    'https://www.notion.so'
  ],
  [
    'ols4',
    'OLS4',
    'Search biomedical ontology terms, hierarchies, cross-references, and semantically similar classes',
    'EMBL-EBI',
    '健康与生命科学',
    '无需登录',
    'https://www.ebi.ac.uk/ols4/api/mcp',
    'https://www.ebi.ac.uk/ols4/mcp'
  ],
  [
    'omics-sniffer',
    'Omics Sniffer',
    'Search harmonized public multi-omics datasets, samples, and file artifacts across 30+ repositories',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/omics-sniffer/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'open-targets',
    'Open Targets Platform',
    'Query human genetics, pathway, expression, and clinical drug evidence linking targets and diseases',
    'Open Targets',
    '健康与生命科学',
    '无需登录',
    'https://mcp.platform.opentargets.org/mcp',
    'https://github.com/opentargets/platform-mcp'
  ],
  [
    'proteomics',
    'Proteomics',
    'Search PRIDE Archive proteomics projects and Human Protein Atlas gene and protein summaries',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/proteomics/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'pubmed',
    'PubMed',
    'Search NCBI PubMed biomedical literature, open-access PMC full text, citations, and PubTator 3.0 entity annotations',
    'Phi Packages',
    '健康与生命科学',
    '无需登录',
    'https://phi.omicsagent.cn/pubmed/mcp',
    'https://github.com/dxsbiocc/phi-packages'
  ],
  [
    'rcsb-mcp',
    'RCSB PDB',
    'Search experimental 3D macromolecular structures, ligands, sequences, and metadata in RCSB PDB',
    'RCSB PDB',
    '健康与生命科学',
    '无需登录',
    'https://mcp-beta.rcsb.org/mcp',
    'https://github.com/rcsb/rcsb-mcp'
  ],
  [
    'serpapi',
    'SerpApi',
    'Fetch real-time structured search results from Google, Google Scholar, and other search engines',
    'SerpApi',
    '生产力',
    '需要凭据',
    'https://mcp.serpapi.com/mcp',
    'https://serpapi.com/integrations/mcp'
  ],
  [
    'string-db',
    'STRING',
    'Query protein-protein interaction networks, cross-species homologs, and functional enrichment',
    'STRING',
    '健康与生命科学',
    '无需登录',
    'https://mcp.string-db.org/',
    'https://github.com/meringlab/string-mcp'
  ],
  [
    'tavily',
    'Tavily',
    'Search the live web, map site pages, and extract clean article text for research workflows',
    'Tavily',
    '生产力',
    '需要凭据',
    'https://mcp.tavily.com/mcp',
    'https://github.com/tavily-ai/tavily-mcp'
  ],
  [
    'transcriptomics-single-cell',
    'Transcriptomics and Single-Cell',
    'Query GTEx expression and eQTLs alongside CELLxGENE, CellGuide, HCA, and HuBMAP single-cell atlases',
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
