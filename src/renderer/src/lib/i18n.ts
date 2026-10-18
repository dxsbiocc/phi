import { useSyncExternalStore } from 'react'
import {
  DEFAULT_UI_LANGUAGE,
  isUiLanguage,
  normalizeUiLanguage,
  systemUiLanguage,
  uiLocale,
  type UiLanguage
} from '../../../shared/uiLanguage'

export { DEFAULT_UI_LANGUAGE, isUiLanguage, normalizeUiLanguage, type UiLanguage }

const STORAGE_KEY = 'phi.uiLanguage'
const listeners = new Set<() => void>()

function initialLanguage(): UiLanguage {
  const fallback =
    typeof navigator === 'undefined'
      ? DEFAULT_UI_LANGUAGE
      : systemUiLanguage(navigator.languages?.length ? navigator.languages : [navigator.language])
  try {
    return typeof window === 'undefined'
      ? fallback
      : normalizeUiLanguage(window.localStorage.getItem(STORAGE_KEY), fallback)
  } catch {
    return fallback
  }
}

let language = initialLanguage()

export function getUiLanguage(): UiLanguage {
  return language
}

export function getUiLocale(): 'en-US' | 'zh-CN' {
  return uiLocale(language)
}

export function setUiLanguage(next: UiLanguage): void {
  if (!isUiLanguage(next)) throw new TypeError('Unsupported interface language')
  const changed = language !== next
  language = next
  if (typeof document !== 'undefined' && document.documentElement)
    document.documentElement.lang = next
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // The main-process settings file is authoritative when browser storage is unavailable.
  }
  if (changed) for (const listener of [...listeners]) listener()
}

export function subscribeUiLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Subscribe wherever localized copy is rendered, including memoized components. */
export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(subscribeUiLanguage, getUiLanguage, getUiLanguage)
}

export type LocalizedCopy<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => Result extends string ? string : Result
  : T extends string
    ? string
    : T extends object
      ? { [Key in keyof T]: LocalizedCopy<T[Key]> }
      : T

/**
 * Keep one semantic copy shape for both languages. Property reads and saved formatter
 * functions resolve the current language; resource data and component state stay intact.
 */
export function defineCopy<const T extends object>(
  english: T,
  chinese: LocalizedCopy<NoInfer<T>>
): LocalizedCopy<T> {
  const translated: unknown = chinese
  if (translated === null || typeof translated !== 'object') {
    throw new TypeError('A translation dictionary must be an object')
  }
  return copyProxy(english, translated) as LocalizedCopy<T>
}

function copyProxy(english: object, chinese: object): object {
  const children = new Map<PropertyKey, unknown>()
  return new Proxy(english, {
    get(target, key, receiver) {
      if (!Object.hasOwn(target, key)) return Reflect.get(target, key, receiver)
      const en: unknown = Reflect.get(target, key)
      const zh: unknown = Reflect.get(chinese, key)
      if (typeof en === 'function') {
        if (!children.has(key)) {
          children.set(key, (...args: unknown[]) => {
            const formatter = language === 'zh-CN' && typeof zh === 'function' ? zh : en
            return Reflect.apply(formatter, undefined, args)
          })
        }
        return children.get(key)
      }
      if (en !== null && typeof en === 'object') {
        if (!children.has(key))
          children.set(key, copyProxy(en, zh !== null && typeof zh === 'object' ? zh : en))
        return children.get(key)
      }
      return language === 'zh-CN' && zh !== undefined ? zh : en
    }
  })
}

if (typeof document !== 'undefined' && document.documentElement)
  document.documentElement.lang = language

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) setUiLanguage(initialLanguage())
  })
}
