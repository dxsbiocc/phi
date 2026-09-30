export interface FeaturedMcpConnector {
  id: string
  name: string
  description: string
  overview: string
  publisher: string
  category: string
  signIn: string
  url: string
  homepageUrl: string
  oauthAuthorizationOrigin?: string
  apiKey?: { header: string; obtainUrl: string }
}

export const mcpConnectorCategories = ['生产力', '沟通协作', '设计创作', '健康与生命科学'] as const

export const featuredMcpConnectors: readonly FeaturedMcpConnector[] = [
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: '搜索、读取和上传云端文件',
    overview:
      'Google Drive 用于存放、搜索和共享文件。连接后，Phi 可以按你的账号权限查找云端文件、读取内容，并在你要求时上传文件。',
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
    overview:
      'Notion 将页面、数据库和团队知识集中在工作区。连接后，Phi 可以搜索和读取你授权的内容，并协助整理页面与信息；可访问的范围由 Notion 授权决定。',
    publisher: 'Notion',
    category: '生产力',
    signIn: '需要登录',
    url: 'https://mcp.notion.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/notion',
    oauthAuthorizationOrigin: 'https://mcp.notion.com'
  },
  {
    id: 'composio',
    name: 'Composio Connect',
    description: '通过一个连接入口使用已授权的第三方应用',
    overview:
      'Composio Connect 提供统一的第三方应用连接入口。登录后，你可以在 Composio 中逐个授权应用，再让 Phi 使用它提供的工具；应用凭据和调用额度由 Composio 管理。适合需要托管授权流程或额外运行组件的服务。',
    publisher: 'Composio',
    category: '生产力',
    signIn: '需要登录',
    url: 'https://connect.composio.dev/mcp',
    homepageUrl: 'https://docs.composio.dev/docs/composio-connect',
    oauthAuthorizationOrigin: 'https://connect.composio.dev'
  },
  {
    id: 'linear',
    name: 'Linear',
    description: '管理问题、项目和团队工作流',
    overview:
      'Linear 用于跟踪问题、规划项目和协调团队工作。连接后，Phi 可以结合工作区内的项目与问题信息协助检索、梳理和管理任务，具体操作受你的 Linear 权限限制。',
    publisher: 'Linear',
    category: '生产力',
    signIn: '需要登录',
    url: 'https://mcp.linear.app/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/linear',
    oauthAuthorizationOrigin: 'https://mcp.linear.app'
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: '联网搜索、提取网页内容并发现网站页面',
    overview:
      'Tavily 为 AI 工作流提供网页搜索、正文提取、站点地图和抓取能力。Phi 连接官方托管 MCP 后，可以按需查找最新网页并读取相关内容；调用使用你自己的 Tavily API key 与额度。',
    publisher: 'Tavily',
    category: '生产力',
    signIn: '需要 API key',
    url: 'https://mcp.tavily.com/mcp',
    homepageUrl: 'https://github.com/tavily-ai/tavily-mcp',
    apiKey: { header: 'Authorization', obtainUrl: 'https://app.tavily.com/home' }
  },
  {
    id: 'serpapi',
    name: 'SerpApi',
    description: '检索多个搜索引擎的实时结构化结果',
    overview:
      'SerpApi 将 Google、Bing、YouTube 等搜索引擎的结果整理成结构化数据。Phi 通过官方托管 MCP 发起搜索，请求使用你自己的 SerpApi API key 与额度；密钥通过请求头发送。',
    publisher: 'SerpApi',
    category: '生产力',
    signIn: '需要 API key',
    url: 'https://mcp.serpapi.com/mcp',
    homepageUrl: 'https://serpapi.com/integrations/mcp',
    apiKey: { header: 'Authorization', obtainUrl: 'https://serpapi.com/manage-api-key' }
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: '搜索、抓取和解析网页内容',
    overview:
      'Firecrawl 提供网页搜索、抓取、解析和站点内容提取工具。Phi 连接官方托管 MCP 后，可使用你自己的 Firecrawl API key 调用账号方案内的工具，无需在本地安装抓取服务。',
    publisher: 'Firecrawl',
    category: '生产力',
    signIn: '需要 API key',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    homepageUrl: 'https://docs.firecrawl.dev/mcp-server',
    apiKey: { header: 'Authorization', obtainUrl: 'https://www.firecrawl.dev/app/api-keys' }
  },
  {
    id: 'browser-use',
    name: 'Browser Use',
    description: '运行云端浏览器任务并查看执行结果',
    overview:
      'Browser Use 让 AI 在云端浏览器中执行网页任务。官方 MCP 提供启动任务、查询进度、继续或停止会话等工具；调用使用你自己的 Browser Use API key 与额度，无需安装本地浏览器代理。',
    publisher: 'Browser Use',
    category: '生产力',
    signIn: '需要 API key',
    url: 'https://api.browser-use.com/v3/mcp',
    homepageUrl: 'https://docs.browser-use.com/cloud/guides/mcp-server',
    apiKey: { header: 'x-browser-use-api-key', obtainUrl: 'https://cloud.browser-use.com/settings' }
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: '搜索邮件、阅读会话并创建草稿',
    overview:
      'Gmail 是 Google 的邮件服务。连接后，Phi 可以按账号权限搜索邮件、阅读会话并协助创建草稿；发送或修改邮件仍应由用户明确发起。',
    publisher: 'Google',
    category: '沟通协作',
    signIn: '需要登录',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    homepageUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server'
  },
  {
    id: 'slack',
    name: 'Slack',
    description: '搜索消息、频道和会话',
    overview:
      'Slack 汇集团队频道和私信。连接后，Phi 可以检索你有权限访问的消息、频道与会话，帮助回顾讨论和查找决策记录。',
    publisher: 'Slack',
    category: '沟通协作',
    signIn: '需要登录',
    url: 'https://mcp.slack.com/mcp',
    homepageUrl: 'https://docs.slack.dev/ai/slack-mcp-server/'
  },
  {
    id: 'figma',
    name: 'Figma',
    description: '获取设计上下文和生成图表',
    overview:
      'Figma 用于协作设计界面和原型。连接后，Phi 可以读取设计文件中的结构与上下文，辅助理解组件、页面和设计规范，并使用服务提供的图表工具。',
    publisher: 'Figma',
    category: '设计创作',
    signIn: '需要登录',
    url: 'https://mcp.figma.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/figma',
    // Authorization is on the Figma site, not the MCP host.
    oauthAuthorizationOrigin: 'https://www.figma.com'
  },
  {
    id: 'canva',
    name: 'Canva',
    description: '搜索、创建和导出设计',
    overview:
      'Canva 提供在线设计与素材制作。连接后，Phi 可以搜索你授权的设计、创建新内容并导出结果，适合演示文稿、社交媒体和其他视觉材料。',
    publisher: 'Canva',
    category: '设计创作',
    signIn: '需要登录',
    url: 'https://mcp.canva.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/canva',
    oauthAuthorizationOrigin: 'https://mcp.canva.com'
  },
  {
    id: 'biorender',
    name: 'BioRender',
    description: '搜索科学插图素材和生成科研图示',
    overview:
      'BioRender 面向科学与医学图示。连接后，Phi 可以查找专业插图素材，并协助制作实验流程、机制示意图等科研视觉内容。',
    publisher: 'BioRender',
    category: '设计创作',
    signIn: '需要登录',
    url: 'https://mcp.services.biorender.com/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/biorender',
    oauthAuthorizationOrigin: 'https://mcp.services.biorender.com'
  },
  {
    id: 'pubmed',
    name: 'PubMed',
    description: '检索生物医学文献、摘要和可获取的 PMC 全文',
    overview:
      'PubMed 汇集生物医学与生命科学文献记录。这个连接器帮助 Phi 检索论文、查看摘要和相关元数据，并在可用时读取 PubMed Central 的开放全文。',
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
    overview:
      'bioRxiv 和 medRxiv 发布尚未经过期刊同行评审的生命科学与医学预印本。这个连接器帮助 Phi 查找研究、阅读摘要与元数据；使用结论时应留意预印本状态。',
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
    overview:
      'ClinicalTrials.gov 收录临床研究的登记信息。这个连接器可用于检索试验、查看招募状态、干预措施和结果记录，帮助定位与疾病或疗法相关的研究。',
    publisher: 'Anthropic',
    category: '健康与生命科学',
    signIn: '无需登录',
    url: 'https://hcls.mcp.claude.com/clinical_trials/mcp',
    homepageUrl: 'https://claude.com/marketplace/connectors/clinical-trials'
  },
  {
    id: 'open-targets',
    name: 'Open Targets Platform',
    description: '检索靶点、疾病、药物及其关联数据',
    overview:
      'Open Targets Platform 整合公开数据，支持系统性识别和评估潜在治疗靶点，并对靶点与疾病的关联进行评分。官方 MCP 为 Phi 提供针对该平台的查询与解释指引，覆盖靶点、疾病及表型、药物、变异、GWAS、分子 QTL、可信集及它们之间的关系。',
    publisher: 'Open Targets',
    category: '健康与生命科学',
    signIn: '无需登录',
    url: 'https://mcp.platform.opentargets.org/mcp',
    homepageUrl: 'https://github.com/opentargets/platform-mcp'
  }
]
