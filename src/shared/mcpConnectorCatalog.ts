export interface FeaturedMcpConnector {
  id: string
  name: string
  description: string
  publisher: string
  category: string
  signIn: string
  url: string
  homepageUrl: string
}

export const mcpConnectorCategories = ['生产力', '沟通协作', '设计创作', '健康与生命科学'] as const

export const featuredMcpConnectors: readonly FeaturedMcpConnector[] = [
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: '搜索、读取和上传云端文件',
    publisher: 'Google',
    category: '生产力',
    signIn: '需要登录',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    homepageUrl: 'https://claude.com/marketplace/connectors/google-drive'
  },
  {
    id: 'notion',
    name: 'Notion',
    description: '搜索、读取和整理工作区内容',
    publisher: 'Notion',
    category: '生产力',
    signIn: '需要登录',
    url: 'https://mcp.notion.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/notion'
  },
  {
    id: 'linear',
    name: 'Linear',
    description: '管理问题、项目和团队工作流',
    publisher: 'Linear',
    category: '生产力',
    signIn: '需要登录',
    url: 'https://mcp.linear.app/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/linear'
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: '搜索邮件、阅读会话并创建草稿',
    publisher: 'Google',
    category: '沟通协作',
    signIn: '需要登录',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    homepageUrl: 'https://claude.com/marketplace/connectors/gmail'
  },
  {
    id: 'slack',
    name: 'Slack',
    description: '搜索消息、频道和会话',
    publisher: 'Slack',
    category: '沟通协作',
    signIn: '需要登录',
    url: 'https://mcp.slack.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/slack'
  },
  {
    id: 'figma',
    name: 'Figma',
    description: '获取设计上下文和生成图表',
    publisher: 'Figma',
    category: '设计创作',
    signIn: '需要登录',
    url: 'https://mcp.figma.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/figma'
  },
  {
    id: 'canva',
    name: 'Canva',
    description: '搜索、创建和导出设计',
    publisher: 'Canva',
    category: '设计创作',
    signIn: '需要登录',
    url: 'https://mcp.canva.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/canva'
  },
  {
    id: 'biorender',
    name: 'BioRender',
    description: '搜索科学插图素材和生成科研图示',
    publisher: 'BioRender',
    category: '设计创作',
    signIn: '需要登录',
    url: 'https://mcp.services.biorender.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/biorender'
  },
  {
    id: 'pubmed',
    name: 'PubMed',
    description: '检索生物医学文献、摘要和可获取的 PMC 全文',
    publisher: 'Anthropic',
    category: '健康与生命科学',
    signIn: '无需登录',
    url: 'https://pubmed.mcp.claude.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/pubmed'
  },
  {
    id: 'biorxiv',
    name: 'bioRxiv',
    description: '检索 bioRxiv 和 medRxiv 预印本',
    publisher: 'Anthropic',
    category: '健康与生命科学',
    signIn: '无需登录',
    url: 'https://hcls.mcp.claude.com/biorxiv/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/biorxiv'
  },
  {
    id: 'clinical-trials',
    name: 'Clinical Trials',
    description: '检索 ClinicalTrials.gov 临床试验',
    publisher: 'Anthropic',
    category: '健康与生命科学',
    signIn: '无需登录',
    url: 'https://hcls.mcp.claude.com/clinical_trials/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/clinical-trials'
  }
]
