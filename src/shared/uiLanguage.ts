export const UI_LANGUAGES = ['en', 'zh-CN'] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]
export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en'

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'en' || value === 'zh-CN'
}

export function systemUiLanguage(preferredLanguages: readonly string[]): UiLanguage {
  const primary = preferredLanguages
    .find((value) => typeof value === 'string' && value.trim())
    ?.trim()
  return primary && /^zh(?:[-_]|$)/i.test(primary) ? 'zh-CN' : DEFAULT_UI_LANGUAGE
}

export function normalizeUiLanguage(
  value: unknown,
  fallback: UiLanguage = DEFAULT_UI_LANGUAGE
): UiLanguage {
  return isUiLanguage(value) ? value : fallback
}

export function uiLocale(language: UiLanguage): 'en-US' | 'zh-CN' {
  return language === 'zh-CN' ? 'zh-CN' : 'en-US'
}
