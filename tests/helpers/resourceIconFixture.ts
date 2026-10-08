import assert from 'node:assert/strict'
import { resourceIconCache } from '../../src/renderer/src/lib/resourceIcons'

export const RESOURCE_ICON_FIXTURE = 'data:image/png;base64,iVBORw0KGgo='

/** Resolves the same metadata bridge the renderer uses without a browser during server rendering. */
export async function cacheResourceIconFixture(key: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        readResourceIcon: async (requested: string) => {
          assert.equal(requested, key)
          return RESOURCE_ICON_FIXTURE
        }
      }
    }
  })
  try {
    assert.equal(await resourceIconCache.read(key), RESOURCE_ICON_FIXTURE)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}
