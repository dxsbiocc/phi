import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const tempRoot = mkdtempSync(join(tmpdir(), 'pi-resources-test-'))
const agentDir = join(tempRoot, 'agent')
const projectA = join(tempRoot, 'project-a')
const projectB = join(tempRoot, 'project-b')

mkdirSync(agentDir, { recursive: true })
mkdirSync(join(agentDir, 'skills', 'user-skill'), { recursive: true })
mkdirSync(projectA, { recursive: true })
mkdirSync(join(projectA, '.phi', 'skills', 'project-a-phi-skill'), { recursive: true })
mkdirSync(join(projectA, '.pi', 'skills', 'project-a-skill'), { recursive: true })
mkdirSync(join(projectB, '.pi'), { recursive: true })
mkdirSync(join(projectB, '.pi', 'skills', 'project-b-skill'), { recursive: true })
mkdirSync(join(projectB, '.omp', 'skills', 'project-b-omp-skill'), { recursive: true })

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

process.env.PI_CODING_AGENT_DIR = agentDir

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

test('listSkills reads project skills from the selected cwd', async () => {
  const { listSkills } = await import('../src/main/agent/resources')

  const projectASkills = await listSkills(projectA)
  const projectBSkills = await listSkills(projectB)

  assert(projectASkills.some((skill) => skill.name === 'project-a-skill'))
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
})
