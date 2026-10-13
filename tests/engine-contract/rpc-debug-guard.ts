// Loaded by Bun before the real CLI. It never inspects provider keys or user files.
if (process.env.PI_REQ_DEBUG !== '0') {
  throw new Error('Private RPC raw request debugging was enabled')
}
export {}
