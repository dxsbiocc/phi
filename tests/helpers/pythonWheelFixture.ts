import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { join } from 'node:path'

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** A small stored ZIP keeps this real-wheel fixture independent of Python build tools. */
function wheelArchive(files: Record<string, string>): Buffer {
  const entries: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path)
    const bytes = Buffer.from(content)
    const checksum = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(bytes.length, 20)
    directory.writeUInt32LE(bytes.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(offset, 42)
    entries.push(local, name, bytes)
    central.push(directory, name)
    offset += local.length + name.length + bytes.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...entries, directory, end])
}

export async function createPythonWheelFixture(
  root: string,
  requires?: string
): Promise<{ url: string; sha256: string; certificate: string; close: () => Promise<void> }> {
  const state = join(root, 'fixture')
  mkdirSync(state, { recursive: true })
  const key = join(state, 'key.pem')
  const certificate = join(state, 'certificate.pem')
  const config = join(state, 'openssl.conf')
  writeFileSync(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n'
  )
  const generated = spawnSync(
    '/usr/bin/openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-x509',
      '-nodes',
      '-days',
      '1',
      '-config',
      config,
      '-keyout',
      key,
      '-out',
      certificate
    ],
    { encoding: 'utf8' }
  )
  if (generated.status !== 0)
    throw new Error(`could not create local TLS fixture: ${generated.stderr}`)
  const serverKey = join(state, 'server-key.pem')
  const serverCertificate = join(state, 'server-certificate.pem')
  const request = join(state, 'server.csr')
  const extensions = join(state, 'server.conf')
  writeFileSync(
    extensions,
    '[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n'
  )
  for (const args of [
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-keyout',
      serverKey,
      '-out',
      request
    ],
    [
      'x509',
      '-req',
      '-in',
      request,
      '-CA',
      certificate,
      '-CAkey',
      key,
      '-CAcreateserial',
      '-days',
      '1',
      '-extfile',
      extensions,
      '-extensions',
      'ext',
      '-out',
      serverCertificate
    ]
  ]) {
    const signed = spawnSync('/usr/bin/openssl', args, { encoding: 'utf8' })
    if (signed.status !== 0) throw new Error(`could not sign local TLS fixture: ${signed.stderr}`)
  }
  const distribution = 'phi_test_app-1.0.0.dist-info'
  const files: Record<string, string> = {
    'phi_test_app.py': 'def main():\n    print("Phi test wheel 1.0.0")\n',
    [`${distribution}/METADATA`]: `Metadata-Version: 2.1\nName: phi-test-app\nVersion: 1.0.0\n${requires ? `Requires-Dist: ${requires}\n` : ''}\n`,
    [`${distribution}/WHEEL`]:
      'Wheel-Version: 1.0\nGenerator: Phi test fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    [`${distribution}/entry_points.txt`]: '[console_scripts]\nphi-test-app = phi_test_app:main\n'
  }
  files[`${distribution}/RECORD`] =
    Object.entries(files)
      .map(
        ([name, content]) =>
          `${name},sha256=${createHash('sha256').update(content).digest('base64url')},${Buffer.byteLength(content)}\n`
      )
      .join('') + `${distribution}/RECORD,,\n`
  let wheel = wheelArchive(files)
  const dependency = wheelArchive({
    'phi_test_dep.py': '',
    'phi_test_dep-1.0.0.dist-info/METADATA':
      'Metadata-Version: 2.1\nName: phi-test-dep\nVersion: 1.0.0\n',
    'phi_test_dep-1.0.0.dist-info/WHEEL':
      'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    'phi_test_dep-1.0.0.dist-info/RECORD':
      'phi_test_dep.py,,\nphi_test_dep-1.0.0.dist-info/METADATA,,\nphi_test_dep-1.0.0.dist-info/WHEEL,,\nphi_test_dep-1.0.0.dist-info/RECORD,,\n'
  })
  const server = createServer(
    { key: readFileSync(serverKey), cert: readFileSync(serverCertificate) },
    (request, response) => {
      const artifact = request.url?.includes('/phi_test_dep-') ? dependency : wheel
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': artifact.length
      })
      response.end(artifact)
    }
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local wheel fixture has no port')
  if (requires?.includes('$DEPENDENCY_URL')) {
    files[`${distribution}/METADATA`] = files[`${distribution}/METADATA`].replace(
      '$DEPENDENCY_URL',
      `https://127.0.0.1:${address.port}/phi_test_dep-1.0.0-py3-none-any.whl`
    )
    delete files[`${distribution}/RECORD`]
    files[`${distribution}/RECORD`] =
      Object.entries(files)
        .map(
          ([name, content]) =>
            `${name},sha256=${createHash('sha256').update(content).digest('base64url')},${Buffer.byteLength(content)}\n`
        )
        .join('') + `${distribution}/RECORD,,\n`
    wheel = wheelArchive(files)
  }
  return {
    url: `https://127.0.0.1:${address.port}/phi_test_app-1.0.0-py3-none-any.whl`,
    sha256: createHash('sha256').update(wheel).digest('hex'),
    certificate,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
