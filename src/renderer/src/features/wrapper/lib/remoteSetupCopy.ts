import { defineCopy } from '../../../lib/i18n'
import { remoteSetupEnglish } from './remoteSetupCopy.en'
import { remoteSetupChinese } from './remoteSetupCopy.zh'

export const remoteSetupCopy = defineCopy(remoteSetupEnglish, remoteSetupChinese)

// Async UI state may have been created before the user changed language. Only this
// feature's exact fixed messages are localized; remote output remains untouched.
const fixedMessageKeys = new Map<string, keyof typeof remoteSetupEnglish>()
for (const key of Object.keys(remoteSetupEnglish) as (keyof typeof remoteSetupEnglish)[]) {
  const english = remoteSetupEnglish[key]
  const chinese = remoteSetupChinese[key]
  if (typeof english === 'string' && typeof chinese === 'string') {
    fixedMessageKeys.set(english, key)
    fixedMessageKeys.set(chinese, key)
  }
}

export function localizeRemoteSetupMessage(message: string): string {
  const key = fixedMessageKeys.get(message)
  if (!key) return message
  const localized = remoteSetupCopy[key]
  return typeof localized === 'string' ? localized : message
}
