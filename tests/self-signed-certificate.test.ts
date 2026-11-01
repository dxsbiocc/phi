import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { writeSelfSignedCertificate } from './helpers/selfSignedCertificate'

test('the fixture certificate is one loopback CA, with each extension written once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-fixture-cert-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const certificate = join(root, 'cert.pem')
  await writeSelfSignedCertificate('127.0.0.1', certificate, join(root, 'key.pem'))

  const parsed = new X509Certificate(await readFile(certificate))
  assert.equal(parsed.ca, true)
  assert.equal(parsed.checkIP('127.0.0.1'), '127.0.0.1')
  const { stdout } = await promisify(execFile)('openssl', [
    'x509',
    '-in',
    certificate,
    '-noout',
    '-text'
  ])
  assert.equal(stdout.match(/X509v3 Basic Constraints/g)?.length, 1)
})

test('fixtures do not generate certificates through the host-dependent -addext', async () => {
  for (const fixture of ['desktopMcpFixture.ts', 'model-gateway-sdk-fixture.ts']) {
    const source = await readFile(join('tests/helpers', fixture), 'utf8')
    assert.doesNotMatch(source, /-addext/, fixture)
  }
})
