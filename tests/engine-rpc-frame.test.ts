import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcFrame } from '../src/main/agent/engine/rpc/types'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import {
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  RPC_CHUNK_PAYLOAD_BYTES,
  RpcFrameCodec,
  encodeRpcCommand
} from '../src/main/agent/engine/rpc/frame-codec'

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

/** Literal wire frames per the official v2 format; no production encoder is used. */
function chunks(payload: Buffer): Record<string, unknown>[] {
  const count = Math.ceil(payload.length / 262144)
  return Array.from({ length: count }, (_, index) => ({
    type: 'rpc_chunk',
    chunkId: 'official-format-fixture',
    index,
    count,
    byteLength: payload.length,
    data: payload.subarray(index * 262144, (index + 1) * 262144).toString('base64')
  }))
}

function largeFixture(): { value: Record<string, unknown>; frames: Record<string, unknown>[] } {
  const value = { type: 'message_update', text: '漢字🧬'.repeat(150000) }
  return { value, frames: chunks(Buffer.from(JSON.stringify(value))) }
}

test('wire limits match locked OMP 18.10.3 and commands use bounded UTF-8 JSONL', () => {
  assert.equal(MAX_RPC_FRAME_BYTES, 1048576)
  assert.equal(MAX_RPC_REASSEMBLED_BYTES, 67108864)
  assert.equal(RPC_CHUNK_PAYLOAD_BYTES, 262144)
  const value = { type: 'prompt', id: 'request', message: '中文🧬\nsecond line' }
  assert.deepEqual(encodeRpcCommand(value), Buffer.from(JSON.stringify(value) + '\n'))
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'prompt', message: '' })) + 1
  assert.equal(
    encodeRpcCommand({ type: 'prompt', message: 'x'.repeat(1048576 - overhead) }).length,
    1048576
  )
  assert.throws(
    () => encodeRpcCommand({ type: 'prompt', message: 'x'.repeat(1048577 - overhead) }),
    /frame limit/
  )
})

test('JSONL handles every UTF-8 byte boundary, coalesced records, CRLF and blank lines', () => {
  const codec = new RpcFrameCodec()
  const value = { type: 'notice', message: '中🧬文' }
  const bytes = Buffer.from(
    ` \r\n${JSON.stringify(value)}\r\n${JSON.stringify({ type: 'agent_end' })}\n`
  )
  const decoded: RpcFrame[] = []
  for (const byte of bytes) decoded.push(...codec.push(Buffer.from([byte])))
  assert.deepEqual(decoded, [value, { type: 'agent_end' }])
  codec.finish()
  assert.deepEqual(new RpcFrameCodec().push(bytes), decoded)
})

test('physical input ceiling counts LF and rejects an unterminated oversized line', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'notice', text: '' })) + 1
  const largest = line({ type: 'notice', text: 'x'.repeat(1048576 - overhead) })
  assert.equal(largest.length, 1048576)
  assert.equal(new RpcFrameCodec().push(largest).length, 1)
  assert.throws(() => new RpcFrameCodec().push(Buffer.alloc(1048576, 32)), /physical frame/)
  assert.throws(
    () => new RpcFrameCodec().push(line({ type: 'notice', text: 'x'.repeat(1048577 - overhead) })),
    /physical frame/
  )
})

test('invalid UTF-8, JSON, frame shapes and partial EOF fail explicitly', () => {
  for (const bytes of [
    Buffer.from('{"type":"event","text":"\xc3("}\n', 'binary'),
    Buffer.from('{broken}\n'),
    line(null),
    line([]),
    line({})
  ]) {
    assert.throws(() => new RpcFrameCodec().push(bytes))
  }
  const codec = new RpcFrameCodec()
  codec.push(Buffer.from('{"type":"agent_end"}'))
  assert.throws(() => codec.finish(), /partial JSONL/)
})

test('v2 reassembles exact Unicode across base64 and transport-byte boundaries', () => {
  const { value, frames } = largeFixture()
  assert.throws(() => new RpcFrameCodec().push(line(frames[0])), /before protocol negotiation/)
  const codec = new RpcFrameCodec()
  codec.enableProtocolV2()
  const bytes = Buffer.concat(frames.map(line))
  const decoded: RpcFrame[] = []
  for (let offset = 0; offset < bytes.length; offset += 65537)
    decoded.push(...codec.push(bytes.subarray(offset, offset + 65537)))
  assert.deepEqual(decoded, [value])
  codec.finish()
})

test('chunk negotiation can change synchronously between records in one read', () => {
  const { value, frames } = largeFixture()
  const codec = new RpcFrameCodec()
  const decoded = codec.push(
    Buffer.concat([line({ type: 'response', command: 'negotiate_protocol' }), ...frames.map(line)]),
    (frame) => {
      if (frame.type === 'response') codec.enableProtocolV2()
    }
  )
  assert.deepEqual(decoded.slice(1), [value])
})

test('chunks require matching ordered metadata and an uninterrupted sequence', () => {
  const { frames } = largeFixture()
  for (const wrong of [
    { ...frames[1], index: 0 },
    { ...frames[1], chunkId: 'other' },
    { ...frames[1], count: Number(frames[1].count) + 1 },
    { ...frames[1], byteLength: Number(frames[1].byteLength) + 1 },
    { type: 'notice', message: 'interruption' }
  ]) {
    const codec = new RpcFrameCodec()
    codec.enableProtocolV2()
    codec.push(line(frames[0]))
    assert.throws(() => codec.push(line(wrong)), /sequence/)
  }
  const codec = new RpcFrameCodec()
  codec.enableProtocolV2()
  assert.throws(() => codec.push(line(frames[1])), /index zero/)
})

test('hostile chunk metadata and noncanonical or oversized base64 are rejected', () => {
  const { frames } = largeFixture()
  for (const overrides of [
    { chunkId: '' },
    { chunkId: 'x'.repeat(129) },
    { index: -1 },
    { index: 0.5 },
    { count: 1 },
    { count: 257 },
    { byteLength: 1048575 },
    { byteLength: 67108865 },
    { data: '' },
    { data: 'AB==' },
    { data: 'AAAA\n' },
    { data: '%%%%' },
    { data: Buffer.alloc(262145).toString('base64') }
  ]) {
    const codec = new RpcFrameCodec()
    codec.enableProtocolV2()
    assert.throws(() => codec.push(line({ ...frames[0], ...overrides })))
  }
})

test('chunk completion verifies exact bytes and EOF cannot drop unfinished chunks', () => {
  const { frames } = largeFixture()
  const codec = new RpcFrameCodec()
  codec.enableProtocolV2()
  codec.push(line(frames[0]))
  assert.throws(() => codec.finish(), /incomplete chunk/)
  const short = new RpcFrameCodec()
  short.enableProtocolV2()
  for (const frame of frames.slice(0, -1)) short.push(line(frame))
  assert.throws(() => short.push(line({ ...frames.at(-1), data: 'eA==' })), /length mismatch/)
  const ceiling = new RpcFrameCodec()
  ceiling.enableProtocolV2()
  assert.deepEqual(ceiling.push(line({ ...frames[0], count: 256, byteLength: 67108864 })), [])
  ceiling.reset()
  assert.throws(() => ceiling.push(line(frames[0])), /before protocol negotiation/)
})

test('Node decoder consumes frames emitted by the actual locked official encoder', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-rpc-official-frames-'))
  try {
    const result = spawnSync(
      resolveBunExecutable(),
      [
        '--eval',
        `
      import { RpcFrameEncoder } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame'
      const encoder = new RpcFrameEncoder(); encoder.setProtocolVersion(2)
      for (const physical of encoder.encodeFrames({ type:'notice', message:'官方🧬'.repeat(180000) })) process.stdout.write(physical)
    `
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30000
      }
    )
    assert.equal(result.status, 0, result.stderr.toString())
    const codec = new RpcFrameCodec()
    codec.enableProtocolV2()
    const decoded: RpcFrame[] = []
    for (let offset = 0; offset < result.stdout.length; offset += 65539)
      decoded.push(...codec.push(result.stdout.subarray(offset, offset + 65539)))
    assert.deepEqual(decoded, [{ type: 'notice', message: '官方🧬'.repeat(180000) }])
    codec.finish()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
