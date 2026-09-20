import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

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
})

test('runtime resource loader includes bundled skills from resources/skills', async () => {
  const { createRuntimeResourceLoader, getBundledSkillsDir } =
    await import('../src/main/agent/runtime/runtime-adapter')

  const bundledSkillsDir = getBundledSkillsDir()
  const loader = createRuntimeResourceLoader({ cwd: projectA, agentDir })

  assert.equal(existsSync(bundledSkillsDir), true)
  assert.equal(loader.options.additionalSkillPaths?.includes(bundledSkillsDir), true)
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
  const databaseConnectorSkill = projectASkills.find(
    (skill) =>
      skill.name === 'create-database-connector' &&
      skill.filePath.includes(join('resources', 'skills', 'create-database-connector'))
  )

  assert(projectASkills.some((skill) => skill.name === 'project-a-skill'))
  assert(bundledSkill)
  assert(databaseConnectorSkill)
  assert.equal(bundledSkill.sourceCategory, 'system')
  assert.equal(bundledSkill.sourceCategoryLabel, 'System')
  assert.equal(databaseConnectorSkill.sourceCategory, 'system')
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
  assert.equal(projectAUserSkill?.sourceCategoryLabel, 'User')
  assert.equal(projectAPhiSkill?.sourceCategory, 'user')
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

test('setSkillDisabled updates skill frontmatter', async () => {
  const { setSkillDisabled } = await import('../src/main/agent/resources')

  const filePath = join(projectA, '.phi', 'skills', 'project-a-phi-skill', 'SKILL.md')

  const disabledSkills = await setSkillDisabled(filePath, true, projectA)
  assert.equal(disabledSkills.find((skill) => skill.filePath === filePath)?.disabled, true)
  assert.match(readFileSync(filePath, 'utf-8'), /disableModelInvocation: true/)
  assert.match(readFileSync(filePath, 'utf-8'), /hide: true/)

  const enabledSkills = await setSkillDisabled(filePath, false, projectA)
  assert.equal(enabledSkills.find((skill) => skill.filePath === filePath)?.disabled, false)
  assert.match(readFileSync(filePath, 'utf-8'), /disableModelInvocation: false/)
  assert.match(readFileSync(filePath, 'utf-8'), /hide: false/)
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
  assert.equal(
    projectAAgents.find((agent) => agent.name === 'project-a-agent')?.trigger,
    '/prompts:project-a-agent'
  )
})
