/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const POLL_MS = 200
const READ_BYTES = 64 * 1024
/** Keep the tail only: enough to find failing files, not the whole suite log. */
const OUTPUT_TAIL_BYTES = 4 * 1024 * 1024

/**
 * Runs node with its output going to a file and forwards that file as it grows. `--test-force-exit`
 * ends the runner with process.exit(), which on a pipe drops whatever has not been taken yet and
 * can cost the end of the report. Writes to a file are synchronous, so nothing is left to drop.
 */
export function runWithReportFile(args, { cwd, onOutput }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'phi-test-report-'))
  const reportPath = path.join(directory, 'report.log')
  const writer = openSync(reportPath, 'a')
  const reader = openSync(reportPath, 'r')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.allocUnsafe(READ_BYTES)
  let tail = ''
  const forward = () => {
    let count = readSync(reader, buffer)
    while (count > 0) {
      const chunk = Buffer.from(buffer.subarray(0, count))
      onOutput(chunk)
      tail = `${tail}${decoder.write(chunk)}`.slice(-OUTPUT_TAIL_BYTES)
      count = readSync(reader, buffer)
    }
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', writer, writer] })
    closeSync(writer)
    const poll = setInterval(forward, POLL_MS)
    const finish = (code, signal) => {
      clearInterval(poll)
      forward()
      closeSync(reader)
      rmSync(directory, { recursive: true, force: true })
      resolve({ code: code ?? 1, signal, tail })
    }
    child.once('error', () => finish(1, null))
    child.once('exit', finish)
  })
}
