const CHINESE_TEXT = /[\u3400-\u9fff]/

/** Add a user-readable Chinese explanation while retaining validator detail for diagnosis. */
export function localizePhiPluginProblemMessage(message: string): string {
  const detail = message.trim()
  if (!detail) return '插件目录不符合 Phi 插件合同。'
  if (CHINESE_TEXT.test(detail)) return detail

  const normalized = detail.toLowerCase()
  let explanation = '插件目录不符合 Phi 插件合同'
  if (normalized.includes('does not exist') || normalized.includes('not found')) {
    explanation = '指定的文件或目录不存在'
  } else if (normalized.includes('cannot read') || normalized.includes('unreadable')) {
    explanation = '无法读取指定的插件内容'
  } else if (normalized.includes('required') || normalized.includes('missing')) {
    explanation = '缺少插件合同要求的必填内容'
  } else if (normalized.includes('conflict')) {
    explanation = '插件名称或工具前缀与已安装内容冲突'
  } else if (
    normalized.includes('must be') ||
    normalized.includes('must match') ||
    normalized.includes('invalid')
  ) {
    explanation = '插件字段或文件格式不正确'
  } else if (normalized.includes('unknown') || normalized.includes('not allowed')) {
    explanation = '插件包含合同不支持的内容'
  }
  return `${explanation}。技术详情：${detail}`
}
