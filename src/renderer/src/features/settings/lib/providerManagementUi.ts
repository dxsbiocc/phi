import { defineCopy } from '../../../lib/i18n'

export const providerManagementUi = defineCopy(
  {
    enabled: 'Enabled',
    disabled: 'Disabled',
    chat: 'Chat',
    decision: 'Decision · JEV',
    providerSwitch: (name: string) => `Enable ${name} provider`,
    modelSwitch: (name: string) => `Enable ${name} model`,
    models: (count: number) => `Models (${count})`,
    search: 'Search models',
    noModels: 'No models available',
    noMatches: 'No matching models',
    more: 'Show more',
    loading: 'Loading model availability…',
    retry: 'Retry',
    loadFailed: 'Could not load model availability',
    saveFailed: 'Could not change model availability',
    decisionHelp:
      'Phi automatically uses an enabled decision model. Otherwise it uses the current conversation model.',
    disabledHelp:
      'Credentials are kept. Changes affect new tasks and model selections; requests already running are not cancelled.',
    credentials: 'Provider credentials are not configured',
    providerOff: 'Enable this provider to use its models.',
    authFailed: 'Could not refresh provider status'
  },
  {
    enabled: '已启用',
    disabled: '已停用',
    chat: '对话',
    decision: '决策 · JEV',
    providerSwitch: (name: string) => `启用 ${name} 提供商`,
    modelSwitch: (name: string) => `启用 ${name} 模型`,
    models: (count: number) => `模型（${count}）`,
    search: '搜索模型',
    noModels: '暂无可用模型',
    noMatches: '没有匹配的模型',
    more: '显示更多',
    loading: '正在加载模型启用状态…',
    retry: '重试',
    loadFailed: '无法加载模型启用状态',
    saveFailed: '无法更改模型启用状态',
    decisionHelp: 'Phi 自动使用已启用的决策模型；没有可用决策模型时，使用当前对话模型。',
    disabledHelp: '保留凭据，对新任务和后续模型选择生效；不取消已在进行的请求。',
    credentials: '尚未配置提供商凭据',
    providerOff: '启用此提供商后即可使用其模型。',
    authFailed: '无法刷新提供商状态'
  }
)
