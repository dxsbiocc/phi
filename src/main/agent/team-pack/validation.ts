import { isAbsolute, posix, win32 } from 'node:path'

import { teamPackError } from './errors'

export function assertTeamId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(value)) {
    throw teamPackError('INVALID_FORMAT', '团队标识格式无效')
  }
}

export function assertTeamName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 100 ||
    hasControlCharacter(value)
  ) {
    throw teamPackError('INVALID_FORMAT', '团队名称格式无效')
  }
}

export function assertSafeRelativePath(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('?') ||
    value.includes('#') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    posix.normalize(value) !== value
  ) {
    throw teamPackError('INVALID_FORMAT', '存储路径必须是安全的相对路径')
  }
  return value
}

export function assertRelease(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw teamPackError('INVALID_FORMAT', '发布版本必须是正整数')
  }
}

export function assertX25519Recipient(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('age1') ||
    value.startsWith('age1pq1') ||
    value.startsWith('age1tag1') ||
    value.startsWith('age1tagpq1') ||
    value.length !== 62
  ) {
    throw teamPackError('INVALID_FORMAT', '成员接收方必须是 age X25519 公钥')
  }
}

export function assertX25519Identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.startsWith('AGE-SECRET-KEY-1') || value.length !== 74) {
    throw teamPackError('INVALID_FORMAT', '成员身份必须是 age X25519 私钥')
  }
}

export function assertIsoDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw teamPackError('INVALID_FORMAT', '时间格式无效')
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}
