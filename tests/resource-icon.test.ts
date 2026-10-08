import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResourceIcon } from '../src/renderer/src/components/ResourceIcon'
import {
  createResourceIconCache,
  observeResourceIconVisibility,
  resourceIconCache
} from '../src/renderer/src/lib/resourceIcons'
import { RESOURCE_ICON_MAX_BYTES } from '../src/shared/resourceIconTypes'

const image = 'data:image/png;base64,iVBORw0KGgo='

test('resource icon reads are shared in flight and reuse the resolved image', async () => {
  const keys: string[] = []
  let resolveRead: (source: string) => void = () => undefined
  const cache = createResourceIconCache(async (key) => {
    keys.push(key)
    return await new Promise<string>((resolve) => {
      resolveRead = resolve
    })
  })
  const first = cache.read('owned-icon')
  const second = cache.read('owned-icon')
  assert.equal(first, second)
  await Promise.resolve()
  assert.deepEqual(keys, ['owned-icon'])
  resolveRead(image)
  assert.equal(await first, image)
  assert.equal(await cache.read('owned-icon'), image)
  assert.deepEqual(keys, ['owned-icon'])
})

test('the icon cache evicts the least recently used entry, including missing icons', async () => {
  const keys: string[] = []
  const cache = createResourceIconCache(async (key) => {
    keys.push(key)
    return key === 'missing' ? null : image
  }, 2)
  await cache.read('first')
  await cache.read('missing')
  assert.equal(await cache.read('first'), image)
  await cache.read('third')
  assert.equal(cache.peek('missing'), undefined)
  assert.equal(cache.peek('first'), image)
  await cache.read('missing')
  assert.deepEqual(keys, ['first', 'missing', 'third', 'missing'])
})

test('missing, rejected, unsafe and oversized images are cached as generic fallbacks', async () => {
  for (const response of [
    null,
    'file:///private/resource/icon.png',
    'https://example.com/icon.png',
    'data:text/html;base64,PHN2Zz4=',
    'data:image/png;base64,not an image',
    `data:image/png;base64,${Buffer.alloc(RESOURCE_ICON_MAX_BYTES + 1).toString('base64')}`
  ]) {
    let reads = 0
    const cache = createResourceIconCache(async () => {
      reads += 1
      return response
    })
    assert.equal(await cache.read('invalid'), null)
    assert.equal(await cache.read('invalid'), null)
    assert.equal(reads, 1)
  }
  const cache = createResourceIconCache(async () => {
    throw new Error('Resource removed')
  })
  assert.equal(await cache.read('removed'), null)
  assert.equal(cache.peek('removed'), null)
})

test('browser image failures replace the cached source with a fallback', async () => {
  const cache = createResourceIconCache(async () => image)
  await cache.read('broken')
  cache.markFailed('broken', 'data:image/png;base64,AAAA')
  assert.equal(cache.peek('broken'), image)
  cache.markFailed('broken', image)
  assert.equal(await cache.read('broken'), null)
})

test('offscreen entries load once on visibility and stop observing after being removed', () => {
  const element = {} as Element
  let notify: (entries: { isIntersecting: boolean }[]) => void = () => undefined
  let reads = 0
  let disconnects = 0
  const observe = (callback: typeof notify): IntersectionObserver => {
    notify = callback
    return {
      observe: (target) => assert.equal(target, element),
      disconnect: () => {
        disconnects += 1
      }
    } as IntersectionObserver
  }
  const stop = observeResourceIconVisibility(
    element,
    () => {
      reads += 1
    },
    observe
  )
  assert.equal(reads, 0)
  notify([{ isIntersecting: false }])
  assert.equal(reads, 0)
  notify([{ isIntersecting: true }])
  notify([{ isIntersecting: true }])
  assert.equal(reads, 1)
  assert.equal(disconnects, 1)
  stop()

  const remove = observeResourceIconVisibility(
    element,
    () => {
      reads += 1
    },
    observe
  )
  remove()
  notify([{ isIntersecting: true }])
  assert.equal(reads, 1)
})

test('webviews without visibility observers still load resource icons', () => {
  let reads = 0
  observeResourceIconVisibility(
    {} as Element,
    () => {
      reads += 1
    },
    undefined
  )
  assert.equal(reads, 1)
})

test('resource rendering starts with each generic kind and resolves decorative images from keys', async () => {
  for (const kind of ['mcp', 'plugin', 'skill', 'wrapper'] as const) {
    const markup = renderToStaticMarkup(createElement(ResourceIcon, { kind, size: 32 }))
    assert.match(markup, new RegExp(`data-phi-resource-icon="${kind}"`))
    assert.match(markup, /aria-hidden="true"/)
    assert.match(markup, /<svg/)
    assert.doesNotMatch(markup, /<img/)
  }

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const key = 'renderer-resolved-icon'
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        readResourceIcon: async (requested: string) => {
          assert.equal(requested, key)
          return image
        }
      }
    }
  })
  try {
    await resourceIconCache.read(key)
    const markup = renderToStaticMarkup(
      createElement(ResourceIcon, { kind: 'skill', icon: { key } })
    )
    assert.match(markup, /<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="[^>]*alt=""/)
    assert.doesNotMatch(markup, /<svg/)
    resourceIconCache.markFailed(key, image)
    const failed = renderToStaticMarkup(
      createElement(ResourceIcon, { kind: 'skill', icon: { key } })
    )
    assert.doesNotMatch(failed, /<img/)
    assert.match(failed, /<svg/)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
