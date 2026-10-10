import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  findResourceIcon,
  findResourceIconSidecar,
  readResourceIcon,
  registerResourceIconAsset
} from '../src/main/agent/resource-icons'
import { RESOURCE_ICON_MAX_BYTES } from '../src/shared/resourceIconTypes'

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16H0z"/></svg>'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64'
)
const WEBP = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=', 'base64')
const JPEG = Buffer.from(
  '/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD4vooor+Uz/fw//9k=',
  'base64'
)

function fixture(callback: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-resource-icon-'))
  try {
    callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function expected(
  data: string | Buffer,
  path = 'icon.svg'
): { path: string; sha256: string; size: number } {
  return {
    path,
    sha256: createHash('sha256').update(data).digest('hex'),
    size: Buffer.byteLength(data)
  }
}

test('conventional image formats have bounded opaque references and correct data URL types', () => {
  fixture((root) => {
    for (const [extension, data, mime] of [
      ['svg', SVG, 'image/svg+xml'],
      ['png', PNG, 'image/png'],
      ['webp', WEBP, 'image/webp'],
      ['jpg', JPEG, 'image/jpeg'],
      ['jpeg', JPEG, 'image/jpeg']
    ] as const) {
      const dir = join(root, extension)
      mkdirSync(dir)
      writeFileSync(join(dir, `icon.${extension}`), data)
      const ref = findResourceIcon(dir)
      assert.ok(ref)
      assert.match(ref.key, /^[a-f0-9]{64}$/)
      assert.equal(ref.key.includes(root), false)
      assert.equal(
        readResourceIcon(ref.key),
        `data:${mime};base64,${Buffer.from(data).toString('base64')}`
      )
      assert.deepEqual(findResourceIcon(dir), ref)
    }
  })
})

test('filename priority, explicit fallback roots, and absent icons are deterministic', () => {
  fixture((root) => {
    const own = join(root, 'own')
    const fallback = join(root, 'fallback')
    mkdirSync(own)
    mkdirSync(fallback)
    writeFileSync(join(fallback, 'icon.svg'), SVG)
    const fallbackRef = findResourceIcon(fallback)
    assert.deepEqual(findResourceIcon(own, [fallback]), fallbackRef)
    writeFileSync(join(own, 'icon.png'), PNG)
    const ownRef = findResourceIcon(own, [fallback])
    assert.ok(ownRef)
    assert.match(readResourceIcon(ownRef.key) ?? '', /^data:image\/png;/)
    writeFileSync(join(own, 'icon.svg'), SVG)
    const preferred = findResourceIcon(own)
    assert.ok(preferred)
    assert.match(readResourceIcon(preferred.key) ?? '', /^data:image\/svg\+xml;/)
    assert.equal(findResourceIcon(join(root, 'missing')), undefined)
    assert.equal(readResourceIcon(join(own, 'icon.svg')), null)
    for (const value of [undefined, null, {}, { key: preferred.key }, 1, '', 'a'.repeat(64)]) {
      assert.equal(readResourceIcon(value), null)
    }
  })
})

test('named resource sidecars keep agents in one directory from sharing an icon', () => {
  fixture((root) => {
    const alpha = join(root, 'Alpha.md')
    const beta = join(root, 'Beta.md')
    writeFileSync(alpha, '# Alpha\n')
    writeFileSync(beta, '# Beta\n')
    writeFileSync(join(root, 'Alpha.icon.webp'), WEBP)
    writeFileSync(join(root, 'Beta.icon.png'), PNG)

    const alphaIcon = findResourceIconSidecar(alpha)
    const betaIcon = findResourceIconSidecar(beta)
    assert.ok(alphaIcon)
    assert.ok(betaIcon)
    assert.notDeepEqual(alphaIcon, betaIcon)
    assert.match(readResourceIcon(alphaIcon.key) ?? '', /^data:image\/webp;/)
    assert.match(readResourceIcon(betaIcon.key) ?? '', /^data:image\/png;/)
    assert.equal(findResourceIconSidecar(join(root, 'Missing.md')), undefined)
  })
})

test('registrations are lazy and changed, replaced, and deleted files invalidate cached bytes', () => {
  fixture((root) => {
    const file = join(root, 'icon.svg')
    writeFileSync(file, SVG)
    const ref = findResourceIcon(root)
    assert.ok(ref)
    const changed = SVG.replace('currentColor', '#112233')
    writeFileSync(file, changed)
    assert.equal(
      readResourceIcon(ref.key),
      `data:image/svg+xml;base64,${Buffer.from(changed).toString('base64')}`
    )
    assert.equal(readResourceIcon(ref.key), readResourceIcon(ref.key))
    writeFileSync(join(root, 'replacement'), SVG)
    renameSync(join(root, 'replacement'), file)
    assert.equal(
      readResourceIcon(ref.key),
      `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`
    )
    writeFileSync(file, '<svg><script>alert(1)</script></svg>')
    assert.equal(readResourceIcon(ref.key), null)
    writeFileSync(file, SVG)
    assert.ok(readResourceIcon(ref.key))
    rmSync(file)
    assert.equal(readResourceIcon(ref.key), null)
  })
})

test('oversized files and mismatched image headers fall back without throwing', () => {
  fixture((root) => {
    writeFileSync(join(root, 'icon.svg'), Buffer.alloc(RESOURCE_ICON_MAX_BYTES + 1, 'x'))
    assert.equal(findResourceIcon(root), undefined)
    for (const extension of ['svg', 'png', 'webp', 'jpg', 'jpeg']) {
      rmSync(join(root, 'icon.svg'), { force: true })
      const file = join(root, `icon.${extension}`)
      writeFileSync(file, '<html><script>bad()</script></html>')
      const ref = findResourceIcon(root)
      assert.ok(ref)
      assert.equal(readResourceIcon(ref.key), null)
      writeFileSync(file, Buffer.alloc(RESOURCE_ICON_MAX_BYTES + 1))
      assert.equal(readResourceIcon(ref.key), null)
      rmSync(file)
    }
  })
})

test('WebP frame variants reject oversized canvases, malformed signatures, and truncated chunks', () => {
  fixture((root) => {
    const file = join(root, 'icon.webp')
    writeFileSync(file, WEBP)
    const ref = findResourceIcon(root)
    assert.ok(ref)
    assert.ok(readResourceIcon(ref.key))
    function header(kind: 'VP8X' | 'VP8L' | 'VP8 ', width: number, height: number): Buffer {
      const payload = Buffer.alloc(kind === 'VP8L' ? 5 : 10)
      if (kind === 'VP8X') {
        payload.writeUIntLE(width - 1, 4, 3)
        payload.writeUIntLE(height - 1, 7, 3)
      } else if (kind === 'VP8L') {
        payload[0] = 0x2f
        payload.writeUInt32LE(width - 1 + (height - 1) * 16384, 1)
      } else {
        payload.set([0x9d, 0x01, 0x2a], 3)
        payload.writeUInt16LE(width, 6)
        payload.writeUInt16LE(height, 8)
      }
      const image = Buffer.alloc(20 + payload.length + (payload.length % 2))
      image.write('RIFF', 0)
      image.writeUInt32LE(image.length - 8, 4)
      image.write('WEBP', 8)
      image.write(kind, 12)
      image.writeUInt32LE(payload.length, 16)
      image.set(payload, 20)
      return image
    }
    for (const kind of ['VP8X', 'VP8L', 'VP8 '] as const) {
      writeFileSync(file, header(kind, 4096, 4096))
      assert.ok(readResourceIcon(ref.key), kind)
      for (const dimensions of [
        [4097, 1],
        [1, 4097],
        [16384, 16384]
      ]) {
        writeFileSync(file, header(kind, dimensions[0], dimensions[1]))
        assert.equal(readResourceIcon(ref.key), null, `${kind}:${dimensions}`)
      }
      const truncated = header(kind, 16, 16).subarray(0, 24)
      truncated.writeUInt32LE(truncated.length - 8, 4)
      writeFileSync(file, truncated)
      assert.equal(readResourceIcon(ref.key), null, kind)
    }
    const badExtended = header('VP8X', 16, 16)
    badExtended[21] = 1
    const badLossless = header('VP8L', 16, 16)
    badLossless[20] = 0
    const badLosslessVersion = header('VP8L', 16, 16)
    badLosslessVersion[24] |= 0x20
    const badLossy = header('VP8 ', 16, 16)
    badLossy[23] = 0
    for (const image of [
      badExtended,
      badLossless,
      badLosslessVersion,
      badLossy,
      header('VP8 ', 0, 1)
    ]) {
      writeFileSync(file, image)
      assert.equal(readResourceIcon(ref.key), null)
    }
  })
})

test('static SVG shapes, local gradients and local use are allowed while active and external SVG is rejected', () => {
  fixture((root) => {
    const file = join(root, 'icon.svg')
    const allowed =
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="a"><stop offset="0" stop-color="#fff"/></linearGradient><path id="b" d="M0 0"/></defs><g style="fill:url(#a);stroke:#000"><use xlink:href="#b"/></g><title>Icon</title></svg>'
    writeFileSync(file, allowed)
    const ref = findResourceIcon(root)
    assert.ok(ref)
    assert.ok(readResourceIcon(ref.key))
    writeFileSync(
      file,
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xml:space="preserve" style="enable-background:new 0 0 16 16"><style type="text/css">.shape,.outline {fill:#fff;stroke:url(#local);fill-rule:evenodd;}</style><metadata>\n </metadata><path class="shape outline" d="M0 0"/></svg>'
    )
    assert.ok(readResourceIcon(ref.key))
    for (const unsafe of [
      '<svg onload="alert(1)"/>',
      '<svg><script>bad()</script></svg>',
      '<svg><foreignObject><div>bad</div></foreignObject></svg>',
      '<svg><image href="https://example.com/a.png"/></svg>',
      '<svg><use href="https://example.com/a.svg#x"/></svg>',
      '<svg><use href="data:image/svg+xml,bad"/></svg>',
      '<svg><path fill="url(https://example.com/a.svg#x)"/></svg>',
      '<svg><path fill="url(&#104;ttps://example.com/a.svg#x)"/></svg>',
      '<svg><path style="fill:url( https://example.com/a.svg#x )"/></svg>',
      '<svg><path style="background:red"/></svg>',
      '<svg><style>@import "https://example.com"</style></svg>',
      '<svg><style>.icon { fill: url(https://example.com/a.svg#x); }</style></svg>',
      '<svg><style>.icon { fill: url(&#104;ttps://example.com/a.svg#x); }</style></svg>',
      '<svg><style>.icon { f\\69ll: red; }</style></svg>',
      '<svg><style>.icon { background: red; }</style></svg>',
      '<svg><style>@media print {.icon {fill:red;}}</style></svg>',
      '<svg><style>path {fill:red;}</style></svg>',
      '<svg><style>.icon:hover {fill:red;}</style></svg>',
      '<svg><style>.icon {fill:expression(alert(1));}</style></svg>',
      '<svg><style>.icon {mask:image-set("external.png" 1x);}</style></svg>',
      '<svg><path mask="image(\'external.png\')"/></svg>',
      '<svg><metadata><script>bad()</script></metadata></svg>',
      '<svg><metadata>unsupported text</metadata></svg>',
      '<svg xmlns:svg="https://example.com/svg"/>',
      '<svg><animate attributeName="href"/></svg>',
      '<!DOCTYPE svg [<!ENTITY external SYSTEM "file:///etc/passwd">]><svg>&external;</svg>',
      '<svg><path></svg>',
      '<svg/><svg/>',
      '<svg width="1" width="2"/>',
      '<html/>',
      '<svg><?processing bad?></svg>'
    ]) {
      writeFileSync(file, unsafe)
      assert.equal(readResourceIcon(ref.key), null, unsafe)
    }
  })
})

test('registry assets require safe paths, matching declared bytes, and a matching expected SHA256', () => {
  fixture((root) => {
    mkdirSync(join(root, 'icons'))
    writeFileSync(join(root, 'icons', 'demo.svg'), SVG)
    const asset = expected(SVG, 'icons/demo.svg')
    const ref = registerResourceIconAsset(root, asset)
    assert.ok(ref)
    assert.ok(readResourceIcon(ref.key))
    const wrongHash = registerResourceIconAsset(root, { ...asset, sha256: 'f'.repeat(64) })
    assert.ok(wrongHash)
    assert.equal(readResourceIcon(wrongHash.key), null)
    assert.equal(registerResourceIconAsset(root, { ...asset, size: asset.size + 1 }), undefined)
    assert.equal(
      registerResourceIconAsset(root, { ...asset, size: RESOURCE_ICON_MAX_BYTES + 1 }),
      undefined
    )
    assert.equal(registerResourceIconAsset(root, { ...asset, sha256: 'not-a-hash' }), undefined)
    for (const path of [
      '../icon.svg',
      '/icon.svg',
      'icons/../icon.svg',
      'icons\\demo.svg',
      'C:/icon.svg',
      'icons//demo.svg',
      'icons/./demo.svg',
      'icons/demo.svg\0'
    ]) {
      assert.equal(registerResourceIconAsset(root, { ...asset, path }), undefined, path)
    }
    writeFileSync(join(root, 'icons', 'demo.svg'), SVG.replace('currentColor', 'currentColox'))
    assert.equal(readResourceIcon(ref.key), null)
  })
})

test('file, directory, and replaced-parent symlinks are rejected even after caching', () => {
  fixture((root) => {
    const outside = join(root, 'outside')
    const resource = join(root, 'resource')
    mkdirSync(outside)
    mkdirSync(resource)
    writeFileSync(join(outside, 'icon.svg'), SVG)
    symlinkSync(join(outside, 'icon.svg'), join(resource, 'icon.svg'))
    assert.equal(findResourceIcon(resource), undefined)
    assert.equal(registerResourceIconAsset(resource, expected(SVG)), undefined)
    rmSync(join(resource, 'icon.svg'))
    symlinkSync(outside, join(resource, 'icons'))
    assert.equal(registerResourceIconAsset(resource, expected(SVG, 'icons/icon.svg')), undefined)
    symlinkSync(outside, join(root, 'linked-root'))
    assert.equal(findResourceIcon(join(root, 'linked-root')), undefined)
    writeFileSync(join(resource, 'icon.svg'), SVG)
    const ref = findResourceIcon(resource)
    assert.ok(ref)
    assert.ok(readResourceIcon(ref.key))
    rmSync(join(resource, 'icon.svg'))
    symlinkSync(join(outside, 'icon.svg'), join(resource, 'icon.svg'))
    assert.equal(readResourceIcon(ref.key), null)
    rmSync(resource, { recursive: true, force: true })
    symlinkSync(outside, resource)
    assert.equal(readResourceIcon(ref.key), null)
  })
})

test('a registration remains confined to its canonical root after an ancestor is swapped', () => {
  fixture((root) => {
    const parent = join(root, 'parent')
    const resource = join(parent, 'resource')
    const outside = join(root, 'outside')
    mkdirSync(resource, { recursive: true })
    mkdirSync(join(outside, 'resource'), { recursive: true })
    writeFileSync(join(resource, 'icon.svg'), SVG)
    writeFileSync(join(outside, 'resource', 'icon.svg'), SVG)
    const ref = findResourceIcon(resource)
    assert.ok(ref)
    assert.ok(readResourceIcon(ref.key))
    renameSync(parent, join(root, 'old-parent'))
    symlinkSync(outside, parent)
    assert.equal(readResourceIcon(ref.key), null)
  })
})

test('registration metadata is bounded and evicted resources can be registered again', () => {
  fixture((root) => {
    writeFileSync(join(root, 'icon.svg'), SVG)
    const asset = expected(SVG)
    const first = registerResourceIconAsset(root, asset)
    assert.ok(first)
    assert.ok(readResourceIcon(first.key))
    for (let index = 0; index < 2050; index += 1) {
      registerResourceIconAsset(root, { ...asset, sha256: index.toString(16).padStart(64, '0') })
    }
    assert.equal(readResourceIcon(first.key), null)
    assert.deepEqual(registerResourceIconAsset(root, asset), first)
    assert.ok(readResourceIcon(first.key))
  })
})
