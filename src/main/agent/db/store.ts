import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'

const DB_CONNECTORS_DIR = 'db-connectors'
const INSTALLED_DIR = 'installed'
const RESULTS_DIR = 'results'
const DOCS_DIR = 'docs'
const NAVIGATOR_DIR = 'db-navigator'
const ALLOW_LIST_FILE = 'allow-list.json'
const AUDIT_LOG_FILE = 'audit.jsonl'
const FIELD_GLOSSARY_FILE = 'field-glossary.md'
const SKILL_FILE = 'SKILL.md'

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

export function getDbConnectorsRootDir(agentDir = getPhiAgentDir()): string {
  return join(agentDir, DB_CONNECTORS_DIR)
}

export function getInstalledDbConnectorsDir(agentDir = getPhiAgentDir()): string {
  return join(getDbConnectorsRootDir(agentDir), INSTALLED_DIR)
}

export function getDbConnectorResultsDir(agentDir = getPhiAgentDir()): string {
  return join(getDbConnectorsRootDir(agentDir), RESULTS_DIR)
}

export function getDbConnectorDocsDir(agentDir = getPhiAgentDir()): string {
  return join(getDbConnectorsRootDir(agentDir), DOCS_DIR)
}

export function getDbConnectorFieldGlossaryPath(agentDir = getPhiAgentDir()): string {
  return join(getDbConnectorDocsDir(agentDir), FIELD_GLOSSARY_FILE)
}

export function getDbConnectorNavigatorSkillPath(agentDir = getPhiAgentDir()): string {
  return join(getDbConnectorsRootDir(agentDir), NAVIGATOR_DIR, SKILL_FILE)
}

export function getDbConnectorAuditLogPath(agentDir = getPhiAgentDir()): string {
  return join(getDbConnectorsRootDir(agentDir), AUDIT_LOG_FILE)
}

export function ensureDbConnectorStorageDirs(agentDir = getPhiAgentDir()): void {
  ensureDir(getInstalledDbConnectorsDir(agentDir))
  ensureDir(getDbConnectorResultsDir(agentDir))
  ensureDir(getDbConnectorDocsDir(agentDir))
}

function getAllowListPath(agentDir: string): string {
  return join(getDbConnectorsRootDir(agentDir), ALLOW_LIST_FILE)
}

function readAllowList(agentDir: string): Record<string, string> {
  const path = getAllowListPath(agentDir)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

function writeAllowList(agentDir: string, allowList: Record<string, string>): void {
  ensureDir(getDbConnectorsRootDir(agentDir))
  writeFileSync(getAllowListPath(agentDir), `${JSON.stringify(allowList, null, 2)}\n`, 'utf-8')
}

export function allowCustomDbConnector(
  id: string,
  digest: string,
  agentDir = getPhiAgentDir()
): void {
  const allowList = readAllowList(agentDir)
  allowList[id] = digest
  writeAllowList(agentDir, allowList)
}

export function isCustomDbConnectorAllowed(
  id: string,
  digest: string,
  agentDir = getPhiAgentDir()
): boolean {
  return readAllowList(agentDir)[id] === digest
}
