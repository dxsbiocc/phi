import type { BrowserError } from '../../shared/browserTypes'
import type { EngineResult, EngineTargetInspection } from './browser-engine'

const MAX_FINGERPRINT_BYTES = 128
const MAX_TAG_BYTES = 32
const MAX_INPUT_TYPE_BYTES = 32
const MAX_ROLE_BYTES = 64
const MAX_LABEL_BYTES = 256
const MAX_FORM_METHOD_BYTES = 16
const MAX_FORM_ACTION_BYTES = 2 * 1024
const MAX_DESCRIPTOR_BYTES = 3 * 1024

const OPTIONAL_DESCRIPTOR_KEYS = new Set([
  'inputType',
  'role',
  'accessibleLabel',
  'formMethod',
  'formAction'
])
const REQUIRED_DESCRIPTOR_KEYS = new Set(['tagName', 'editable', 'submitsForm'])
const SENSITIVE_INPUT_TYPES = new Set(['password', 'file', 'one-time-code'])
const EMBEDDED_CONTENT_TAGS = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'WEBVIEW'])
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week'
])
const FORBIDDEN_AUTOMATION_LABEL =
  /(?:\b(?:buy|purchase|checkout|place\s+order|confirm\s+order|pay|payment|transfer|subscribe|delete|remove|destroy|close\s+account|create\s+account|sign\s*up|captcha|upload|grant\s+permission|allow\s+access|certificate|http\s+auth)\b|购买|下单|确认订单|付款|支付|转账|订阅|删除|移除|销毁|关闭账户|创建账户|注册账户|验证码|人机验证|上传|授予权限|允许访问|证书|身份认证)/iu

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function bounded(value: unknown, maxBytes: number, pattern?: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    byteLength(value) <= maxBytes &&
    (pattern ? pattern.test(value) : true)
  )
}

function exactDescriptorKeys(value: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Object.keys(value)) {
    if (!REQUIRED_DESCRIPTOR_KEYS.has(key) && !OPTIONAL_DESCRIPTOR_KEYS.has(key)) return false
  }
  return [...REQUIRED_DESCRIPTOR_KEYS].every((key) => Object.hasOwn(value, key))
}

function hasUnsafeLabelCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true
    }
  }
  return false
}

export function validatedBrowserTargetInspection(
  result: EngineResult
): EngineTargetInspection | null {
  if (
    !result.ok ||
    !result.target ||
    !bounded(result.targetFingerprint, MAX_FINGERPRINT_BYTES, /^target-[1-9][0-9]{0,31}$/)
  ) {
    return null
  }
  const raw = result.target as unknown
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const descriptor = raw as Record<string, unknown>
  if (!exactDescriptorKeys(descriptor)) return null
  if (!bounded(descriptor.tagName, MAX_TAG_BYTES, /^[A-Z][A-Z0-9-]*$/)) return null
  if (typeof descriptor.editable !== 'boolean' || typeof descriptor.submitsForm !== 'boolean') {
    return null
  }
  if (
    descriptor.inputType !== undefined &&
    !bounded(descriptor.inputType, MAX_INPUT_TYPE_BYTES, /^[a-z0-9-]+$/)
  ) {
    return null
  }
  if (descriptor.role !== undefined && !bounded(descriptor.role, MAX_ROLE_BYTES, /^[a-z0-9-]+$/)) {
    return null
  }
  if (
    descriptor.accessibleLabel !== undefined &&
    (!bounded(descriptor.accessibleLabel, MAX_LABEL_BYTES) ||
      hasUnsafeLabelCodePoint(descriptor.accessibleLabel))
  ) {
    return null
  }
  if (
    descriptor.formMethod !== undefined &&
    !bounded(descriptor.formMethod, MAX_FORM_METHOD_BYTES, /^[a-z]+$/)
  ) {
    return null
  }
  if (
    descriptor.formAction !== undefined &&
    !bounded(descriptor.formAction, MAX_FORM_ACTION_BYTES)
  ) {
    return null
  }
  if (typeof descriptor.formAction === 'string') {
    try {
      const url = new URL(descriptor.formAction)
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.toString() !== descriptor.formAction
      ) {
        return null
      }
    } catch {
      return null
    }
  }
  if (byteLength(JSON.stringify(descriptor)) > MAX_DESCRIPTOR_BYTES) return null
  return {
    descriptor: {
      tagName: descriptor.tagName as string,
      ...(Object.hasOwn(descriptor, 'inputType')
        ? { inputType: descriptor.inputType as string }
        : {}),
      ...(Object.hasOwn(descriptor, 'role') ? { role: descriptor.role as string } : {}),
      ...(Object.hasOwn(descriptor, 'accessibleLabel')
        ? { accessibleLabel: descriptor.accessibleLabel as string }
        : {}),
      ...(Object.hasOwn(descriptor, 'formMethod')
        ? { formMethod: descriptor.formMethod as string }
        : {}),
      ...(Object.hasOwn(descriptor, 'formAction')
        ? { formAction: descriptor.formAction as string }
        : {}),
      editable: descriptor.editable as boolean,
      submitsForm: descriptor.submitsForm as boolean
    },
    fingerprint: result.targetFingerprint
  }
}

function error(
  tabId: string,
  code: 'PERMISSION_DENIED' | 'USER_HANDOFF_REQUIRED',
  message: string
): { ok: false; error: BrowserError } {
  return { ok: false, error: { code, message, retryable: false, tabId } }
}

export function authorizeBrowserTarget(options: {
  action: 'click' | 'typeText'
  tabId: string
  inspection: EngineTargetInspection
  consequence?: 'read' | 'write' | 'irreversible'
}): { ok: true } | { ok: false; error: BrowserError } {
  const descriptor = options.inspection.descriptor
  if (EMBEDDED_CONTENT_TAGS.has(descriptor.tagName)) {
    return error(
      options.tabId,
      'USER_HANDOFF_REQUIRED',
      'Embedded browser targets require user takeover'
    )
  }
  if (descriptor.inputType && SENSITIVE_INPUT_TYPES.has(descriptor.inputType)) {
    return error(
      options.tabId,
      'USER_HANDOFF_REQUIRED',
      'This browser field requires user takeover'
    )
  }
  if (
    descriptor.accessibleLabel !== undefined &&
    FORBIDDEN_AUTOMATION_LABEL.test(descriptor.accessibleLabel)
  ) {
    return error(
      options.tabId,
      'USER_HANDOFF_REQUIRED',
      'This browser action requires user takeover'
    )
  }
  if (
    options.action === 'click' &&
    options.consequence !== undefined &&
    options.consequence !== 'read' &&
    !descriptor.accessibleLabel &&
    !descriptor.submitsForm
  ) {
    return error(options.tabId, 'USER_HANDOFF_REQUIRED', 'This browser target is not clear enough')
  }
  if (options.action === 'typeText') {
    const ordinaryInput =
      descriptor.tagName === 'INPUT' &&
      descriptor.inputType !== undefined &&
      TEXT_INPUT_TYPES.has(descriptor.inputType)
    const textarea = descriptor.tagName === 'TEXTAREA' && descriptor.inputType === undefined
    const contentEditable = descriptor.inputType === 'contenteditable'
    if (!descriptor.editable || (!ordinaryInput && !textarea && !contentEditable)) {
      return error(options.tabId, 'PERMISSION_DENIED', 'The focused browser target is not editable')
    }
  }
  return { ok: true }
}
