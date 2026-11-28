import { defineCopy } from '../../../lib/i18n'

const mcpAuthPromptEnglish = {
  oauthTitle: 'Connector sign-in required',
  apiKeyTitle: 'Connector API key required',
  oauthSubtitle:
    'Complete browser sign-in here so Phi can connect this Connector directly in the current conversation.',
  apiKeySubtitle:
    'Verify your API key here to connect this Connector in the current conversation. Keys are stored encrypted on this device and never enter chat messages.',
  connectorLabel: 'Connector',
  publisherLabel: 'Publisher',
  authOriginLabel: 'Sign-in service',
  openSignInSite: 'Open sign-in site ↗',
  openDocs: 'Documentation ↗',
  obtainApiKey: (name: string) => `Get ${name} API key ↗`,
  apiKeyLabel: 'API key',
  apiKeyPlaceholder: 'Enter API key',
  serpApiDisclosure:
    'SerpApi requires sending the key once in an HTTPS query parameter for verification. Phi does not save that URL.',
  composioHint: 'After signing in to Composio, authorize individual third-party apps as needed.',
  signInWithBrowser: 'Sign in with browser',
  waitingBrowserSignIn:
    'Waiting for sign-in in your browser… Complete authorization there to continue automatically.',
  cancelSignIn: 'Cancel sign-in',
  verifyAndConnect: 'Verify and enable',
  verifying: 'Verifying…',
  skipForNow: 'Skip for now',
  ariaLabel: (name: string) => `Connector authentication required: ${name}`,
  errorTimeout:
    'Sign-in was not completed within two minutes. Select Sign in with browser to try again.',
  errorCancelled: 'Sign-in was cancelled. You can try again or skip for now.',
  errorApiMissing:
    'The Connector authentication interface is unavailable. Restart Phi and try again.',
  errorInvalidKey: 'The API key was rejected by the service. Check the key and try again.'
}

const mcpAuthPromptChinese: typeof mcpAuthPromptEnglish = {
  oauthTitle: '连接器需要登录授权',
  apiKeyTitle: '连接器需要配置 API Key',
  oauthSubtitle: '在当前卡片发起浏览器登录授权，完成后将直接在本次对话中连接并启用该 MCP 工具。',
  apiKeySubtitle:
    '在此输入并验证 API Key 即可直接在当前对话启用该连接器。密钥仅加密保存在本机，不会写入对话消息或发送给模型。',
  connectorLabel: '连接器',
  publisherLabel: '提供方',
  authOriginLabel: '授权站点',
  openSignInSite: '打开授权站点 ↗',
  openDocs: '服务文档 ↗',
  obtainApiKey: (name: string) => `获取 ${name} API Key ↗`,
  apiKeyLabel: 'API Key',
  apiKeyPlaceholder: '输入 API Key',
  serpApiDisclosure:
    'SerpApi 需要在一次 HTTPS 查询参数中发送密钥以完成验证，Phi 不会保存该验证链接。',
  composioHint: '完成 Composio 登录后，可按需继续授权具体第三方应用。',
  signInWithBrowser: '打开浏览器授权登录',
  waitingBrowserSignIn: '正在等待浏览器完成登录授权… 授权成功后将自动继续当前对话。',
  cancelSignIn: '取消授权',
  verifyAndConnect: '验证并启用',
  verifying: '正在验证…',
  skipForNow: '稍后配置',
  ariaLabel: (name: string) => `连接器需要完成认证：${name}`,
  errorTimeout: '登录等待超过两分钟已自动取消，可点击按钮重新发起授权。',
  errorCancelled: '授权已取消，可重新发起登录或选择稍后配置。',
  errorApiMissing: '连接器认证接口尚未就绪，请重启 Phi 后重试。',
  errorInvalidKey: 'API Key 验证未通过，请核对密钥后重试。'
}

export const mcpAuthPromptCopy = defineCopy(mcpAuthPromptEnglish, mcpAuthPromptChinese)
