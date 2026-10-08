import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { installPlugin } from '../src/main/agent/plugins/loader'

const tempRoot = mkdtempSync(join(tmpdir(), 'pi-resources-test-'))
const agentDir = join(tempRoot, 'agent')
const codexHome = join(tempRoot, 'codex')
const projectA = join(tempRoot, 'project-a')
const projectB = join(tempRoot, 'project-b')

mkdirSync(agentDir, { recursive: true })
mkdirSync(join(agentDir, 'skills', 'user-skill'), { recursive: true })
mkdirSync(join(agentDir, 'prompts'), { recursive: true })
mkdirSync(join(codexHome, 'prompts'), { recursive: true })
mkdirSync(join(codexHome, 'agents'), { recursive: true })
mkdirSync(projectA, { recursive: true })
mkdirSync(join(projectA, '.phi', 'skills', 'project-a-phi-skill'), { recursive: true })
mkdirSync(join(projectA, '.phi', 'prompts'), { recursive: true })
mkdirSync(join(projectA, '.pi', 'skills', 'project-a-skill'), { recursive: true })
mkdirSync(join(projectB, '.pi'), { recursive: true })
mkdirSync(join(projectB, '.pi', 'skills', 'project-b-skill'), { recursive: true })
mkdirSync(join(projectB, '.omp', 'skills', 'project-b-omp-skill'), { recursive: true })
mkdirSync(join(projectB, '.omp', 'prompts'), { recursive: true })

writeFileSync(
  join(agentDir, 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      userServer: { command: 'user-cmd', args: ['--user'], env: { TOKEN: 'redacted' } }
    }
  })
)
writeFileSync(
  join(projectA, '.phi', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      projectAPhiServer: { command: 'project-a-phi-cmd' }
    }
  })
)
writeFileSync(
  join(projectA, '.mcp.json'),
  JSON.stringify({
    mcpServers: {
      projectAServer: { command: 'project-a-cmd' }
    }
  })
)
writeFileSync(
  join(projectB, '.pi', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      projectBServer: { command: 'project-b-cmd' }
    }
  })
)
writeFileSync(
  join(projectB, '.omp', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      projectBOmpServer: { command: 'project-b-omp-cmd' }
    }
  })
)
writeFileSync(
  join(agentDir, 'skills', 'user-skill', 'SKILL.md'),
  '---\ndescription: User skill fixture\n---\n# User skill\n'
)
writeFileSync(
  join(projectA, '.phi', 'skills', 'project-a-phi-skill', 'SKILL.md'),
  '---\ndescription: Project A Phi skill fixture\n---\n# Project A Phi skill\n'
)
writeFileSync(
  join(projectA, '.pi', 'skills', 'project-a-skill', 'SKILL.md'),
  '---\ndescription: Project A skill fixture\n---\n# Project A skill\n'
)
writeFileSync(
  join(projectB, '.pi', 'skills', 'project-b-skill', 'SKILL.md'),
  '---\ndescription: Project B skill fixture\n---\n# Project B skill\n'
)
writeFileSync(
  join(projectB, '.omp', 'skills', 'project-b-omp-skill', 'SKILL.md'),
  '---\ndescription: Project B OMP skill fixture\n---\n# Project B OMP skill\n'
)
writeFileSync(
  join(agentDir, 'prompts', 'user-agent.md'),
  '---\ndescription: User prompt fixture\n---\n# User prompt\n'
)
writeFileSync(
  join(projectA, '.phi', 'prompts', 'project-a-agent.md'),
  '---\ndescription: Project A agent fixture\n---\n# Project A agent\n'
)
writeFileSync(
  join(projectB, '.omp', 'prompts', 'project-b-agent.md'),
  '---\ndescription: Project B agent fixture\n---\n# Project B agent\n'
)
writeFileSync(
  join(codexHome, 'prompts', 'codex-agent.md'),
  '---\ndescription: Codex prompt fixture\n---\n# Codex prompt\n'
)
writeFileSync(
  join(codexHome, 'agents', 'codex-toml-agent.toml'),
  'name = "codex-toml-agent"\ndescription = "Codex TOML agent fixture"\n'
)

process.env.PI_CODING_AGENT_DIR = agentDir
process.env.CODEX_HOME = codexHome

const visualizationInstall = installPlugin(
  join(process.cwd(), 'resources', 'plugins', 'visualization'),
  { agentDir, runtimeRoot: join(tempRoot, 'runtime') }
)
assert.equal(visualizationInstall.ok, true, JSON.stringify(visualizationInstall.errors))
assert.ok(visualizationInstall.plugin)
const visualizationSkillDir = visualizationInstall.plugin.components.skills[0]
assert.ok(visualizationSkillDir)

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

test('listMcpServers reads MCP config from the selected cwd', async () => {
  const { listMcpServers } = await import('../src/main/agent/resources')

  const projectAServers = await listMcpServers(projectA)
  const projectBServers = await listMcpServers(projectB)

  assert.deepEqual(
    projectAServers.map((server) => server.name),
    ['projectAPhiServer', 'projectAServer', 'userServer']
  )
  assert.deepEqual(
    projectBServers.map((server) => server.name),
    ['projectBOmpServer', 'projectBServer', 'userServer']
  )
  assert.equal(
    projectAServers.find((server) => server.name === 'userServer')?.envKeys?.[0],
    'TOKEN'
  )
  assert.equal(projectAServers.find((server) => server.name === 'userServer')?.managed, true)
  assert.equal(projectAServers.find((server) => server.name === 'projectAServer')?.managed, false)
})

test('listMcpServers includes remote URL-only servers', async () => {
  const { listGlobalMcpServers } = await import('../src/main/agent/resources')
  const path = join(agentDir, 'mcp.json')
  const original = readFileSync(path, 'utf8')
  try {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          pubmed: { type: 'http', url: 'https://example.com/mcp', phiPackage: 'pubmed' }
        }
      })
    )
    const servers = await listGlobalMcpServers()
    assert.equal(servers[0]?.name, 'pubmed')
    assert.equal(servers[0]?.url, 'https://example.com/mcp')
    assert.equal(servers[0]?.transport, 'http')
    assert.equal(servers[0]?.packageId, 'pubmed')
    assert.equal(servers[0]?.connectorId, 'pubmed')
  } finally {
    writeFileSync(path, original)
  }
})

test('remote resource catalog keeps global Skills and MCP without reading an anchor project', async () => {
  const { listGlobalMcpServers, listGlobalSkills, readGlobalSkillContent } =
    await import('../src/main/agent/resources')
  const anchor = join(agentDir, 'remote-project-anchors', 'remote-project')
  mkdirSync(join(anchor, '.phi', 'skills', 'anchor-skill'), { recursive: true })
  writeFileSync(
    join(anchor, '.phi', 'skills', 'anchor-skill', 'SKILL.md'),
    '---\ndescription: Anchor must be ignored\n---\n# Fake\n'
  )
  writeFileSync(
    join(anchor, '.mcp.json'),
    JSON.stringify({ mcpServers: { anchorServer: { command: 'never-run' } } })
  )

  const skills = await listGlobalSkills()
  assert(skills.some((skill) => skill.name === 'user-skill'))
  assert.equal(
    skills.some((skill) => skill.name === 'anchor-skill'),
    false
  )
  assert.deepEqual(
    (await listGlobalMcpServers()).map((server) => server.name),
    ['userServer']
  )
  const globalFile = join(agentDir, 'skills', 'user-skill', 'SKILL.md')
  assert.match((await readGlobalSkillContent(globalFile)).content, /User skill/)
  await assert.rejects(
    readGlobalSkillContent(join(anchor, '.phi', 'skills', 'anchor-skill', 'SKILL.md')),
    /远程项目级 Skill 暂不可用/
  )
})

test('runtime resource loader includes only core authoring skill from resources/skills', async () => {
  const { createRuntimeResourceLoader, getBundledSkillsDir } =
    await import('../src/main/agent/runtime/runtime-adapter')

  const bundledSkillsDir = getBundledSkillsDir()
  const loader = createRuntimeResourceLoader({ cwd: projectA, agentDir })

  assert.equal(existsSync(bundledSkillsDir), true)
  assert.equal(loader.options.additionalSkillPaths?.includes(bundledSkillsDir), false)
  assert.equal(
    loader.options.additionalSkillFiles?.includes(
      join(bundledSkillsDir, 'create-wrapper/SKILL.md')
    ),
    true
  )
  await loader.reload()
  assert.equal(
    loader.getSkills().skills.some((skill) => skill.name === 'create-wrapper'),
    true
  )
  assert.equal(
    loader
      .getSkills()
      .skills.some(
        (skill) => skill.filePath.startsWith(bundledSkillsDir) && skill.name !== 'create-wrapper'
      ),
    false
  )
})

test('listSkills reads project skills from the selected cwd', async () => {
  const { listSkills } = await import('../src/main/agent/resources')

  const projectASkills = await listSkills(projectA)
  const projectBSkills = await listSkills(projectB)
  const projectAUserSkill = projectASkills.find((skill) => skill.name === 'user-skill')
  const projectAPhiSkill = projectASkills.find((skill) => skill.name === 'project-a-phi-skill')
  const bundledSkill = projectASkills.find(
    (skill) =>
      skill.name === 'anndata' && skill.filePath.includes(join('resources', 'skills', 'anndata'))
  )
  const omicsVisualizationSkill = projectASkills.find(
    (skill) =>
      skill.name === 'omics-visualization' &&
      skill.filePath === join(visualizationSkillDir, 'SKILL.md')
  )

  assert(projectASkills.some((skill) => skill.name === 'project-a-skill'))
  assert.equal(bundledSkill, undefined)
  assert(omicsVisualizationSkill)
  assert.equal(omicsVisualizationSkill.sourceCategory, 'plugin')
  assert.equal(omicsVisualizationSkill.sourceCategoryLabel, '插件')
  assert.equal(omicsVisualizationSkill.sourceId, 'visualization')
  assert(
    projectASkills.some(
      (skill) => skill.name === 'project-a-phi-skill' && skill.scope === 'project'
    )
  )
  assert(!projectASkills.some((skill) => skill.name === 'project-b-skill'))
  assert(projectBSkills.some((skill) => skill.name === 'project-b-skill'))
  assert(
    projectBSkills.some(
      (skill) => skill.name === 'project-b-omp-skill' && skill.scope === 'project'
    )
  )
  assert(!projectBSkills.some((skill) => skill.name === 'project-a-skill'))
  assert(projectASkills.some((skill) => skill.name === 'user-skill' && skill.scope === 'user'))
  assert.equal(projectAUserSkill?.sourceCategory, 'user')
  assert.equal(projectAUserSkill?.sourceCategoryLabel, '我的')
  assert.equal(projectAPhiSkill?.sourceCategory, 'project')
  assert.equal(projectAPhiSkill?.sourceCategoryLabel, '项目')
})

test('listSkills exposes declared metadata and omits absent, blank or malformed fields', async () => {
  const { listSkills } = await import('../src/main/agent/resources')
  const metadataProject = join(tempRoot, 'metadata-project')
  const fixtures = [
    {
      name: 'declared-metadata',
      fields:
        'metadata:\n  version: " 1.3 "\nphi:\n  environment: " phi:python@1 "\n  deprecated: " Use modern instead. "'
    },
    { name: 'version-only', fields: 'metadata:\n  version: "2.0"' },
    { name: 'environment-only', fields: 'phi:\n  environment: ./environment.yml' },
    { name: 'absent-metadata', fields: '' },
    { name: 'malformed-blocks', fields: 'metadata: []\nphi: invalid' },
    {
      name: 'malformed-values',
      fields: 'metadata:\n  version: 3\nphi:\n  environment: [python]\n  deprecated: false'
    },
    {
      name: 'blank-metadata',
      fields: 'metadata:\n  version: " "\nphi:\n  environment: " "\n  deprecated: " "'
    }
  ]
  for (const fixture of fixtures) {
    const skillDir = join(metadataProject, '.phi', 'skills', fixture.name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${fixture.name}\ndescription: Metadata fixture\n${fixture.fields}\n---\n# Fixture\n`
    )
  }

  const skills = await listSkills(metadataProject)
  const declared = skills.find((skill) => skill.name === 'declared-metadata')
  assert.equal(declared?.environment, 'phi:python@1')
  assert.equal(declared?.version, '1.3')
  assert.equal(declared?.deprecated, 'Use modern instead.')
  const versionOnly = skills.find((skill) => skill.name === 'version-only')
  assert.equal(versionOnly?.version, '2.0')
  assert.equal(versionOnly?.environment, undefined)
  const environmentOnly = skills.find((skill) => skill.name === 'environment-only')
  assert.equal(environmentOnly?.environment, './environment.yml')
  assert.equal(environmentOnly?.version, undefined)
  for (const name of [
    'absent-metadata',
    'malformed-blocks',
    'malformed-values',
    'blank-metadata'
  ]) {
    const summary = skills.find((skill) => skill.name === name)
    assert.ok(summary, `${name} remains available in the skill catalog`)
    for (const field of ['deprecated', 'environment', 'version']) {
      assert.equal(Object.hasOwn(summary, field), false, `${name} does not invent ${field}`)
    }
  }
})

test('readSkillContent reads only cataloged skill files', async () => {
  const { readSkillContent } = await import('../src/main/agent/resources')

  const filePath = join(projectA, '.phi', 'skills', 'project-a-phi-skill', 'SKILL.md')
  const result = await readSkillContent(filePath, projectA)

  assert.equal(result.filePath, filePath)
  assert.match(result.content, /# Project A Phi skill/)
  await assert.rejects(
    () =>
      readSkillContent(join(projectB, '.pi', 'skills', 'project-b-skill', 'SKILL.md'), projectA),
    /not available/
  )
})

test('setSkillDisabled updates enablement without rewriting skill files', async () => {
  const { setSkillDisabled } = await import('../src/main/agent/resources')

  const filePath = join(projectA, '.phi', 'skills', 'project-a-phi-skill', 'SKILL.md')
  const original = readFileSync(filePath, 'utf-8')

  const disabledSkills = await setSkillDisabled(filePath, true, projectA)
  assert.equal(disabledSkills.find((skill) => skill.filePath === filePath)?.disabled, true)
  assert.equal(readFileSync(filePath, 'utf-8'), original)

  const enabledSkills = await setSkillDisabled(filePath, false, projectA)
  assert.equal(enabledSkills.find((skill) => skill.filePath === filePath)?.disabled, false)
  assert.equal(readFileSync(filePath, 'utf-8'), original)
})

test('deleteSkill removes mutable cataloged skill directories', async () => {
  const { deleteSkill } = await import('../src/main/agent/resources')

  const skillDir = join(projectA, '.phi', 'skills', 'delete-me')
  const filePath = join(skillDir, 'SKILL.md')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(filePath, '---\ndescription: Delete me fixture\n---\n# Delete me\n')

  const skills = await deleteSkill(filePath, projectA)

  assert.equal(existsSync(skillDir), false)
  assert(!skills.some((skill) => skill.filePath === filePath))
  await assert.rejects(
    () => deleteSkill(join(projectB, '.pi', 'skills', 'project-b-skill', 'SKILL.md'), projectA),
    /not available/
  )
})

test('listPromptAgents reads prompt agents from the selected cwd', async () => {
  const { listPromptAgents } = await import('../src/main/agent/resources')

  const projectAAgents = await listPromptAgents(projectA)
  const projectBAgents = await listPromptAgents(projectB)
  const projectANames = projectAAgents.map((agent) => agent.name)
  const projectBNames = projectBAgents.map((agent) => agent.name)

  assert(projectANames.includes('project-a-agent'))
  assert(!projectANames.includes('project-b-agent'))
  assert(projectBNames.includes('project-b-agent'))
  assert(!projectBNames.includes('project-a-agent'))
  assert(projectANames.includes('user-agent'))
  assert(projectANames.includes('codex-agent'))
  assert(projectANames.includes('codex-toml-agent'))
  assert(projectANames.includes('Visualization'))
  assert(!projectANames.includes('Database'))
  assert(projectANames.includes('Wrapper'))
  assert.equal(
    projectAAgents.find((agent) => agent.name === 'project-a-agent')?.trigger,
    '/prompts:project-a-agent'
  )
  assert.equal(projectAAgents.find((agent) => agent.name === 'Visualization')?.source, 'phi-agent')
  assert.equal(
    projectAAgents.find((agent) => agent.name === 'Visualization')?.trigger,
    '调用智能体：Visualization'
  )
})
