import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { OfficeHostRequest } from './office-tools'
import { safeOfficeDeliverMessage } from './office-deliver-errors'

const OFFICE_DELIVER_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputName: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^(?!\\.{1,2}$)(?=.*\\S)[^\\\\/\\u0000-\\u001F\\u007F]+$',
      description: '输出文件名；只能是文件名，扩展名由当前 Office 文档类型决定。'
    }
  }
} as const

export function buildOfficeDeliverTool(requestHost: OfficeHostRequest): CustomTool {
  return {
    name: 'office_deliver',
    label: '交付 Office 文件',
    description:
      '将当前运行关联的 Office 草稿保存为当前会话工作区中的新文件，重新打开并检查内容后生成交付卡。目标文档由运行绑定；只能指定可选文件名，不能指定路径、artifactId 或会话。不会覆盖已有文件。',
    loadMode: 'essential',
    approval: 'write',
    parameters: OFFICE_DELIVER_PARAMETERS,
    async execute(toolCallId, params) {
      try {
        const result = await requestHost('office.deliver', deliverParams(params), { toolCallId })
        return deliveryResult(result)
      } catch {
        return errorResult('delivery_failed', 'Office 文件交付失败，请稍后重试')
      }
    }
  }
}

function deliverParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !Object.hasOwn(value, 'outputName')) return {}
  return { outputName: value.outputName }
}

function deliveryResult(value: unknown): ReturnType<typeof errorResult> | ToolSuccess {
  if (!isRecord(value)) return errorResult('delivery_failed', 'Office 文件交付失败，请稍后重试')
  if (value.ok === false && isRecord(value.error) && typeof value.error.code === 'string') {
    const code = value.error.code
    return errorResult(code, safeOfficeDeliverMessage(code))
  }
  if (value.ok !== true || !isRecord(value.value)) {
    return errorResult('delivery_failed', 'Office 文件交付失败，请稍后重试')
  }
  return { content: [{ type: 'text', text: JSON.stringify(value.value) }] }
}

type ToolSuccess = { content: Array<{ type: 'text'; text: string }> }

function errorResult(
  code: string,
  message: string
): ToolSuccess & { isError: true; details: unknown } {
  const details = { code, message }
  return { content: [{ type: 'text', text: JSON.stringify(details) }], isError: true, details }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
