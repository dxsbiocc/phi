import { StringDecoder } from 'node:string_decoder'

import type { RemoteStdioProcess } from '../../src/main/agent/wrappers/remote-ssh-session'
import type { RpcGeneration } from './workspace'

/**
 * Observes the RPC stdout of one channel for the bootstrap attestation of the expected
 * extension bundle. The production attester validates every authority; this only records
 * the nonce so cleanup can confirm that exactly the attested generation directories are gone.
 */
export function observeAttestation(
  record: RpcGeneration,
  channel: RemoteStdioProcess,
  expectedBundle: string,
  generations: string[]
): void {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  channel.stdout.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk)
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      try {
        const frame = JSON.parse(line)
        if (
          frame.type !== 'extension_ui_request' ||
          frame.method !== 'notify' ||
          typeof frame.message !== 'string'
        )
          continue
        const note = JSON.parse(frame.message)
        if (
          note.type === 'phi_rpc_bootstrap_attestation' &&
          note.contentHash === expectedBundle &&
          /^[a-f0-9-]{36}$/.test(note.nonce) &&
          !generations.includes(note.nonce)
        ) {
          generations.push(note.nonce)
          record.nonce = note.nonce
          record.attestedAt = performance.now()
        }
      } catch {
        /* Not a frame this observer cares about. */
      }
    }
  })
}
