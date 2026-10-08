import type { TrustedRegistryKey } from './signature'

// Public identity only. The private release-signing key lives outside both repositories.
export const TRUSTED_REGISTRY_KEYS: readonly TrustedRegistryKey[] = [
  {
    keyId: '3ba7dc7aaefc0274',
    publicKey:
      '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAw382r06oX4UkSNX8g8yc1fBlDdrD8fL+bsVO1QzjLWE=\n-----END PUBLIC KEY-----\n'
  }
]
