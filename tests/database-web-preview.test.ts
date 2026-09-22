import assert from 'node:assert/strict'
import test from 'node:test'
import { previewDatabaseWebImage } from '../src/main/database-web-preview'
import {
  databaseWebPreviewKindFromString,
  databaseWebPreviewRequestFromString,
  isDatabaseWebPreviewUrl
} from '../src/shared/databaseWebPreview'

test('STRING network page urls become image API preview requests', () => {
  const request = databaseWebPreviewRequestFromString(
    'https://string-db.org/network/9606.ENSP00000281030'
  )

  assert.equal(request?.kind, 'string-network')
  assert.equal(request?.label, 'STRING 网络')
  assert.equal(
    request?.imageUrl,
    'https://string-db.org/api/image/network?identifiers=9606.ENSP00000281030&species=9606&network_flavor=evidence&caller_identity=Phi&add_white_nodes=10'
  )
})

test('KEGG pathway urls become REST image preview requests', () => {
  assert.deepEqual(databaseWebPreviewRequestFromString('https://www.kegg.jp/pathway/hsa00010'), {
    kind: 'kegg-pathway',
    label: 'KEGG 通路图',
    sourceUrl: 'https://www.kegg.jp/pathway/hsa00010',
    imageUrl: 'https://rest.kegg.jp/get/hsa00010/image'
  })
  assert.equal(
    databaseWebPreviewRequestFromString('https://www.kegg.jp/kegg-bin/show_pathway?map=hsa04110')
      ?.imageUrl,
    'https://rest.kegg.jp/get/hsa04110/image'
  )
})

test('database webpage preview accepts only supported official hosts', () => {
  assert.equal(
    databaseWebPreviewKindFromString('https://www.kegg.jp/pathway/hsa00010'),
    'kegg-pathway'
  )
  assert.equal(isDatabaseWebPreviewUrl('https://example.com/network/9606.ENSP00000281030'), false)
  assert.equal(isDatabaseWebPreviewUrl('http://www.kegg.jp/pathway/hsa00010'), false)
})

test('main process database webpage preview fetches png as data url', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })
  }

  try {
    const preview = await previewDatabaseWebImage(
      'https://string-db.org/network/9606.ENSP00000281030'
    )
    assert.equal(requests.length, 1)
    assert.match(requests[0], /^https:\/\/string-db\.org\/api\/image\/network/)
    assert.equal(preview.kind, 'string-network')
    assert.equal(preview.mimeType, 'image/png')
    assert.equal(preview.bytes, 3)
    assert.equal(preview.dataUrl, 'data:image/png;base64,AQID')
  } finally {
    globalThis.fetch = originalFetch
  }
})
