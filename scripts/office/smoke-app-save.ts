import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { Page } from 'puppeteer-core'

const READY_TIMEOUT_MS = 60_000

interface SaveSmokeArtifact {
  artifactId: string
  draftPath: string
}

interface OutputRecord {
  outputId: string
  outputPath: string
  revision: number
  sha256: string
  size: number
}

export async function exerciseOfficeSaveAndSaveAs(
  page: Page,
  artifact: SaveSmokeArtifact,
  projectDir: string,
  targetPath: string,
  screenshotDir: string
): Promise<OutputRecord> {
  await page.waitForSelector('[data-phi-office-save-state="saved"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  await page.click('[data-phi-office-save-draft="true"]')
  await page.waitForSelector('[data-phi-office-save-state="saved"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })

  await page.click('[data-phi-office-save-as="true"]')
  await page.waitForSelector('[data-phi-office-save-as-success="true"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  assert.ok(existsSync(targetPath), '另存目标未创建')
  const firstHash = sha256(targetPath)
  const record = outputRecord(artifact.draftPath, targetPath, projectDir)
  assert.equal(record.sha256, firstHash)
  assert.equal(record.size, readFileSync(targetPath).length)

  await page.click('[data-phi-office-save-as="true"]')
  await page.waitForSelector('[data-phi-office-save-as-error="true"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  const message = await page.$eval(
    '[data-phi-office-save-as-error="true"]',
    (element) => element.textContent ?? ''
  )
  assert.match(message, /目标文件已存在/u)
  assert.equal(sha256(targetPath), firstHash, '重复另存覆盖了既有输出')
  assert.equal(outputRecords(artifact.draftPath).length, 1, '失败另存产生了成功输出记录')
  await delay(100)
  await page.screenshot({ path: join(screenshotDir, '03-office-save-as.png') })
  return record
}

function outputRecord(draftPath: string, targetPath: string, projectDir: string): OutputRecord {
  const records = outputRecords(draftPath)
  assert.equal(records.length, 1)
  const record = records[0]!
  assert.equal(join(projectDir, record.outputPath), targetPath)
  return record
}

function outputRecords(draftPath: string): OutputRecord[] {
  const path = join(dirname(draftPath), 'outputs.json')
  const value = JSON.parse(readFileSync(path, 'utf8')) as { outputs?: OutputRecord[] }
  return value.outputs ?? []
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
