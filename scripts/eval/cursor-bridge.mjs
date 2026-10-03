// Starts Phi's Cursor HTTP/2 bridge under Node (Bun cannot speak Cursor's TLS HTTP/2 leg)
// and prints its loopback URL, so db-vs-fetch.ts can use cursor/* models outside the app.
// Usage: node --import ./scripts/test-loader.mjs scripts/eval/cursor-bridge.mjs
import { createCursorH2Bridge } from '../../src/main/agent/cursor-h2-bridge'

const bridge = createCursorH2Bridge()
const url = await bridge.ensure()
console.log(url)
process.on('SIGTERM', () => void bridge.close().then(() => process.exit(0)))
process.on('SIGINT', () => void bridge.close().then(() => process.exit(0)))
