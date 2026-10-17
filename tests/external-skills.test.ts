import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { isEnabled } from '../src/main/agent/enablement'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  createExternalSkillService,
  type ExternalSkillApprovalRequest,
  type ExternalSkillDependencies
} from '../src/main/agent/packages/external-skills'
import { listInstalledPackages } from '../src/main/agent/packages/installed'
import { runPackageMutation } from '../src/main/agent/packages/mutation-queue'

const SHA = 'a'.repeat(40)
const REPO = 'example/scientific-skills'
const SKILL = 'scanpy'
const SESSION = 'runtime-session-1'

function skillText(name = SKILL, extra = ''): string {
  return `---\nname: ${name}\ndescription: Analyze single-cell expression matrices.\n${extra}---\n# ${name}\nUse bundled reference files.\n`
}

function snapshot(files: Record<string, string>): Buffer {
  return createDeterministicTarGz(
    Object.entries(files).map(([path, text]) => ({
      path: `scientific-skills-${SHA}/${path}`,
      data: Buffer.from(text)
    }))
  )
}

function fixture(
  t: test.TestContext,
  options: {
    skills?: unknown[]
    archive?: Buffer
    confirm?: ExternalSkillDependencies['confirm']
    assertCurrent?: ExternalSkillDependencies['assertCurrent']
    onDownload?: () => void
  } = {}
): {
  service: ReturnType<typeof createExternalSkillService>
  agentDir: string
  calls: Array<{ url: string; init?: RequestInit }>
  approvals: ExternalSkillApprovalRequest[]
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-external-skills-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const approvals: ExternalSkillApprovalRequest[] = []
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.startsWith('https://skills.sh/api/search?'))
      return Response.json({
        skills: options.skills ?? [
          { source: REPO, skillId: SKILL, id: `${REPO}/${SKILL}`, name: SKILL }
        ],
        count: 1
      })
    if (url.endsWith('.git/info/refs?service=git-upload-pack'))
      return new Response('', { status: 503 })
    if (url === `https://api.github.com/repos/${REPO}/commits/HEAD`)
      return Response.json({ sha: SHA })
    if (url === `https://codeload.github.com/${REPO}/tar.gz/${SHA}`) {
      options.onDownload?.()
      return new Response(
        new Uint8Array(
          options.archive ??
            snapshot({
              'scientific-skills/scanpy/SKILL.md': skillText(),
              'scientific-skills/scanpy/references/manual.md': 'Reference content'
            })
        )
      )
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const service = createExternalSkillService({
    agentDir,
    appVersion: '0.1.0',
    fetch: fetcher,
    assertCurrent: options.assertCurrent,
    confirm: async (request, context) => {
      approvals.push(request)
      assert.equal(
        calls.some((call) => call.url.includes('codeload.github.com')),
        false
      )
      assert.equal(existsSync(agentDir), false)
      return options.confirm ? options.confirm(request, context) : true
    }
  })
  return { service, agentDir, calls, approvals }
}

async function candidate(service: ReturnType<typeof createExternalSkillService>): Promise<string> {
  const result = await service.findSkills({ runtimeSessionId: SESSION, query: SKILL }, {})
  assert.equal(result.candidates.length, 1)
  return result.candidates[0]!.candidateId
}

function request(candidateId: string): {
  runtimeSessionId: string
  candidateId: string
  reason: string
} {
  return {
    runtimeSessionId: SESSION,
    candidateId,
    reason: 'The current analysis needs single-cell processing.'
  }
}

test('find_skills queries the documented API and returns session-bound imported candidates', async (t) => {
  const { service, calls, agentDir } = fixture(t)
  const result = await service.findSkills(
    {
      runtimeSessionId: SESSION,
      query: '  single cell & RNA  ',
      limit: 5,
      requestId: 'host-request',
      toolCallId: 'tool-call'
    },
    {}
  )
  const url = new URL(calls[0]!.url)
  assert.equal(url.origin, 'https://skills.sh')
  assert.equal(url.pathname, '/api/search')
  assert.equal(url.searchParams.get('q'), 'single cell & RNA')
  assert.equal(url.searchParams.get('limit'), '5')
  assert.equal(calls[0]!.init?.credentials, 'omit')
  assert.equal(calls[0]!.init?.redirect, 'error')
  const selected = result.candidates[0]!
  assert.equal(selected.trust, 'imported')
  assert.equal(selected.source, REPO)
  assert.equal(service.ownsCandidate(selected.candidateId, SESSION), true)
  assert.equal(service.ownsCandidate(selected.candidateId, 'other-session'), false)
  assert.equal(existsSync(agentDir), false)
})

test('find_skills rejects invalid query, session and limit before network access', async (t) => {
  const { service, calls } = fixture(t)
  for (const params of [
    null,
    {},
    { runtimeSessionId: '', query: 'scanpy' },
    { runtimeSessionId: SESSION, query: ' ' },
    { runtimeSessionId: SESSION, query: 'x'.repeat(501) },
    { runtimeSessionId: SESSION, query: SKILL, limit: 0 },
    { runtimeSessionId: SESSION, query: SKILL, limit: 51 },
    { runtimeSessionId: SESSION, query: SKILL, limit: 1.5 }
  ]) {
    await assert.rejects(service.findSkills(params, {}), /搜索参数无效/)
  }
  assert.equal(calls.length, 0)
})

test('find_skills discards malicious sources, refs, paths and skill names', async (t) => {
  const badSources = [
    'https://evil.example/repo',
    '../repo',
    'example/../repo',
    'example/repo/tree/main',
    'example/repo?url=https://evil.example',
    'example/repo%2fother',
    'example/repo.git',
    'example/repo/'
  ]
  const { service, calls } = fixture(t, {
    skills: [
      ...badSources.map((source) => ({ source, skillId: SKILL })),
      { source: REPO, skillId: '../../escape' },
      { source: REPO, skillId: SKILL },
      { source: REPO, skillId: SKILL }
    ]
  })
  const result = await service.findSkills(
    { runtimeSessionId: SESSION, query: SKILL, limit: 20 },
    {}
  )
  assert.equal(result.candidates.length, 1)
  assert.equal(result.errors.length, badSources.length + 1)
  assert.equal(calls.length, 1)
})

test('external installation requires approval and pins both download and provenance to the approved SHA', async (t) => {
  const { service, agentDir, calls, approvals } = fixture(t)
  const id = await candidate(service)
  const result = await service.install(request(id), {})
  assert.equal(result.ok, true)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0]!.sha, SHA)
  assert.equal(approvals[0]!.repo, REPO)
  assert.equal(approvals[0]!.skill, SKILL)
  assert.match(approvals[0]!.question, new RegExp(SHA))
  assert.ok(approvals[0]!.question.includes(`用途：${request(id).reason}`))
  assert.equal(calls.filter((call) => call.url.includes('codeload.github.com')).length, 1)
  assert.ok(calls.some((call) => call.url.endsWith(`/tar.gz/${SHA}`)))
  assert.equal(
    calls.some((call) => /npx|api\/download/.test(call.url)),
    false
  )
  const installed = listInstalledPackages({ agentDir })
  assert.equal(installed.length, 1)
  assert.equal(installed[0]!.trust, 'imported')
  assert.equal(installed[0]!.registry, `external-skill:${REPO}/${SKILL}@${SHA}`)
  assert.equal(readFileSync(join(installed[0]!.dir, 'SKILL.md'), 'utf8'), skillText())
  assert.equal(
    readFileSync(join(installed[0]!.dir, 'references/manual.md'), 'utf8'),
    'Reference content'
  )
  assert.equal(
    isEnabled(
      { key: `skill:${SKILL}`, source: 'installed-package' },
      { agentDir, logger: { info: (): void => undefined, warn: (): void => undefined } }
    ),
    true
  )
  assert.deepEqual(readdirSync(join(agentDir, '.staging')), [])
  assert.equal(service.ownsCandidate(id, SESSION), false)
  if (result.ok) assert.equal(result.usage[0]!.path, join(installed[0]!.dir, 'SKILL.md'))
})

test('denial consumes the candidate without downloading or writing to the agent directory', async (t) => {
  const { service, agentDir, calls } = fixture(t, { confirm: async () => false })
  const id = await candidate(service)
  const result = await service.install(request(id), {})
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 'denied')
  assert.equal(
    calls.some((call) => call.url.includes('codeload.github.com')),
    false
  )
  assert.equal(existsSync(agentDir), false)
  await assert.rejects(service.install(request(id), {}), /候选无效或已过期/)
})

test('installation refuses another session and model-supplied approval or source overrides', async (t) => {
  const { service, calls, approvals } = fixture(t)
  const id = await candidate(service)
  await assert.rejects(
    service.install({ ...request(id), runtimeSessionId: 'other-session' }, {}),
    /候选无效或已过期/
  )
  for (const override of [
    { approved: true },
    { repo: 'evil/repo' },
    { url: 'https://evil.example' },
    { destination: '/tmp/escape' }
  ]) {
    await assert.rejects(service.install({ ...request(id), ...override }, {}), /安装参数无效/)
  }
  assert.equal(approvals.length, 0)
  assert.equal(calls.length, 1)
})

test('abort while awaiting approval returns promptly and never installs', async (t) => {
  const controller = new AbortController()
  const { service, agentDir, calls } = fixture(t, {
    confirm: async () => {
      controller.abort()
      return new Promise<boolean>(() => {})
    }
  })
  const result = await service.install(request(await candidate(service)), {
    signal: controller.signal
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 'cancelled')
  assert.equal(existsSync(agentDir), false)
  assert.equal(
    calls.some((call) => call.url.includes('codeload.github.com')),
    false
  )
})

test('abort after approval while waiting for the mutation queue does not download or write', async (t) => {
  const controller = new AbortController()
  let release!: () => void
  let approved!: () => void
  const approval = new Promise<void>((resolve) => {
    approved = resolve
  })
  const blocked = runPackageMutation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await Promise.resolve()
  const { service, agentDir, calls } = fixture(t, {
    confirm: async () => {
      approved()
      return true
    }
  })
  try {
    const pending = service.install(request(await candidate(service)), {
      signal: controller.signal
    })
    await approval
    // Let the approved task enqueue behind the blocked package mutation.
    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()
    release()
    const result = await pending
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 'cancelled')
    assert.equal(existsSync(agentDir), false)
    assert.equal(
      calls.some((call) => call.url.includes('codeload.github.com')),
      false
    )
  } finally {
    release()
    await blocked
  }
})

test('abort during snapshot download cleans temporary content and never publishes a skill', async (t) => {
  const controller = new AbortController()
  const { service, agentDir } = fixture(t, { onDownload: () => controller.abort() })
  const result = await service.install(request(await candidate(service)), {
    signal: controller.signal
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 'cancelled')
  assert.deepEqual(listInstalledPackages({ agentDir }), [])
  assert.deepEqual(readdirSync(join(agentDir, '.staging')), [])
})

test('current-run assertion prevents publication when the session retires during download', async (t) => {
  let retired = false
  const { service, agentDir } = fixture(t, {
    onDownload: () => {
      retired = true
    },
    assertCurrent: () => {
      if (retired) throw new Error('Session retired')
    }
  })
  await assert.rejects(service.install(request(await candidate(service)), {}), /Session retired/)
  assert.deepEqual(listInstalledPackages({ agentDir }), [])
  assert.deepEqual(readdirSync(join(agentDir, '.staging')), [])
})

test('duplicate skill names are rejected even when one lives at the conventional path', async (t) => {
  const { service, agentDir } = fixture(t, {
    archive: snapshot({
      'skills/scanpy/SKILL.md': skillText(),
      'nested/also/SKILL.md': skillText()
    })
  })
  await assert.rejects(service.install(request(await candidate(service)), {}), /多个同名技能/)
  assert.deepEqual(listInstalledPackages({ agentDir }), [])
  assert.deepEqual(readdirSync(join(agentDir, '.staging')), [])
})

test('a directory name alone cannot install a skill declaring another identity', async (t) => {
  const { service, agentDir } = fixture(t, {
    archive: snapshot({ 'skills/scanpy/SKILL.md': skillText('different-skill') })
  })
  await assert.rejects(service.install(request(await candidate(service)), {}), /名称不一致/)
  assert.deepEqual(listInstalledPackages({ agentDir }), [])
})

test('valid frontmatter selects a skill inside a differently named directory and retains semver metadata', async (t) => {
  const { service, agentDir } = fixture(t, {
    archive: snapshot({
      'collection/nested/cell-analysis/SKILL.md': skillText(
        SKILL,
        'metadata:\n  version: "2.3.4"\n'
      )
    })
  })
  const result = await service.install(request(await candidate(service)), {})
  assert.equal(result.ok, true)
  assert.equal(listInstalledPackages({ agentDir })[0]!.version, '2.3.4')
})

test('unsafe symlink and traversal archives are rejected by the existing snapshot verifier', async (t) => {
  await t.test('symlink', async (t) => {
    const tar = gunzipSync(snapshot({ 'skills/scanpy/SKILL.md': skillText() }))
    tar[156] = '2'.charCodeAt(0)
    tar.fill(0x20, 148, 156)
    const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
    tar.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
    tar[154] = 0
    tar[155] = 0x20
    const { service, agentDir } = fixture(t, { archive: gzipSync(tar) })
    await assert.rejects(service.install(request(await candidate(service)), {}), /不允许链接/)
    assert.deepEqual(listInstalledPackages({ agentDir }), [])
  })
  await t.test('traversal', async (t) => {
    const { service, agentDir } = fixture(t, {
      archive: snapshot({ '../escape/SKILL.md': skillText() })
    })
    await assert.rejects(service.install(request(await candidate(service)), {}), /路径不安全/)
    assert.deepEqual(listInstalledPackages({ agentDir }), [])
  })
})

test('invalid SKILL.md fails the normal package validation and leaves no installed content', async (t) => {
  const { service, agentDir } = fixture(t, {
    archive: snapshot({
      'skills/scanpy/SKILL.md': '---\nname: scanpy\ndescription: 12\n---\nInvalid skill\n'
    })
  })
  await assert.rejects(service.install(request(await candidate(service)), {}), /软件包类型验证失败/)
  assert.deepEqual(listInstalledPackages({ agentDir }), [])
  assert.deepEqual(readdirSync(join(agentDir, '.staging')), [])
})
