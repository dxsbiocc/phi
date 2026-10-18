import { defineCopy } from './i18n'

export const providerErrorCopy = defineCopy(
  {
    requestFailed: 'Request failed',
    notebookEmptyTitle: 'No notebook cell to insert',
    notebookEmptyBody:
      'The model response could not be converted to a notebook cell. Review the original response excerpt and try again.',
    cursorLimitTitle: 'Cursor usage limit reached',
    cursorLimitBody:
      'Cursor reached this account’s model usage limit and marked the request as non-retryable. Switch models or adjust the Spend Limit in your Cursor account.',
    billingTitle: 'Insufficient account balance',
    billingBody:
      'The API account has insufficient balance or an outstanding bill. Add credit or check billing in the provider console, then try again.',
    rateLimitTitle: 'Too many requests',
    rateLimitBody:
      'The provider is rate limiting requests. Wait a moment and try again, or select a model or API account with a higher limit.',
    authenticationTitle: 'Invalid API key or authentication failed',
    authenticationBody:
      'The provider could not authenticate the request. Update its API key and make sure the credentials allow model requests for that provider.',
    configureProvider: 'Open provider settings',
    cursorTransportTitle: 'Cursor HTTP/2 connection failed',
    cursorTransportBody:
      'Cursor may be signed in, but its model connection could not establish HTTP/2. Phi uses a local bridge; if the problem continues, check your network proxy and try again.',
    configurationTitle: 'Provider needs attention',
    configurationBody:
      'No provider, model or credentials are available for this request. Check your provider settings and try again.',
    requestFailedBody:
      'The model request did not finish. Review the original error, address the issue and try again.'
  },
  {
    requestFailed: '请求失败',
    notebookEmptyTitle: '没有可插入的 notebook cell',
    notebookEmptyBody: '模型返回内容未能转换成 notebook cell。请查看原始返回片段后重试。',
    cursorLimitTitle: 'Cursor 用量上限已用尽',
    cursorLimitBody:
      'Cursor 已达到当前账户的模型用量上限，并标记此次请求不可重试。请切换模型，或在 Cursor 账户中调整 Spend Limit。',
    billingTitle: '账户余额不足',
    billingBody: '检测到 API 账户余额不足或欠费。请到对应 Provider 控制台充值或检查账单后重试。',
    rateLimitTitle: '请求太频繁',
    rateLimitBody:
      'Provider 当前触发了速率限制。请稍等片刻后重试，或切换到限额更高的模型/API 账户。',
    authenticationTitle: 'API Key 无效或认证失败',
    authenticationBody:
      'Provider 返回认证失败。请重新配置对应 Provider 的 API Key，并确认使用的是该 Provider 的模型调用凭据。',
    configureProvider: '去配置 Provider',
    cursorTransportTitle: 'Cursor HTTP/2 连接失败',
    cursorTransportBody:
      'Cursor 登录状态可能正常，但模型运行通道未能建立 HTTP/2 连接。Phi 会使用本机桥接；若仍失败，请检查网络代理后重试。',
    configurationTitle: 'Provider 需要处理',
    configurationBody: '当前请求没有可用的 Provider、模型或凭据。请检查 Provider 后重试。',
    requestFailedBody: '模型请求没有完成，请根据原始错误信息处理后重试。'
  }
)
