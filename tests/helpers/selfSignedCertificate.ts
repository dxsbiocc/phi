import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

/**
 * Self-signed CA certificate for 127.0.0.1 whose content does not depend on the host's OpenSSL.
 *
 * The configuration is explicit because OpenSSL 1.1.1 (the `openssl` on GitHub's macOS runners)
 * appends `req -addext` values to what its default config's v3_ca already adds, which writes
 * basicConstraints twice, and Bun's TLS client refuses to connect to such a certificate.
 */
export async function writeSelfSignedCertificate(
  commonName: string,
  certificatePath: string,
  keyPath: string
): Promise<void> {
  const configPath = `${certificatePath}.cnf`
  await writeFile(
    configPath,
    [
      '[req]',
      'distinguished_name = subject',
      'x509_extensions = extensions',
      'prompt = no',
      '[subject]',
      `CN = ${commonName}`,
      '[extensions]',
      'subjectAltName = IP:127.0.0.1',
      'basicConstraints = critical,CA:TRUE',
      ''
    ].join('\n'),
    { mode: 0o600 }
  )
  await promisify(execFile)(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-days',
      '1',
      '-config',
      configPath
    ],
    { maxBuffer: 8192 }
  )
}
