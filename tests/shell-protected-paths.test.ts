import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRemoteUrlGuardExtension } from '../src/main/agent/engine/phi-extension/extensions/remote-url-guard'
import { projectToolBoundaryDecision } from '../src/main/agent/engine/phi-extension/lib/project-boundary'
import { protectedShellWrite } from '../src/main/agent/engine/phi-extension/lib/shell-protected-paths'

test('commands that change shell profiles or credentials are found', () => {
  for (const [command, target] of [
    ['echo "export PATH=/opt/nf/bin:$PATH" >> ~/.bashrc', '~/.bashrc'],
    ['echo x>>$HOME/.zshrc', '$HOME/.zshrc'],
    ['printf alias >"${HOME}/.bash_profile"', '"${HOME}/.bash_profile"'],
    ['cd data && cat >> /home/dengxsh/.profile <<EOF', '/home/dengxsh/.profile'],
    ['bash -c "echo hi > ~/.bashrc"', '~/.bashrc"'],
    ['ln -sf /opt/nextflow ~/.config/nextflow', '~/.config/nextflow'],
    ['cp id_ed25519.pub /Users/me/.ssh/authorized_keys', '/Users/me/.ssh/authorized_keys'],
    ['sed -i "s/a/b/" ~/.condarc', '~/.condarc'],
    ['echo key | tee -a ~/.netrc', '~/.netrc'],
    ['conda init bash', 'conda'],
    ['micromamba shell init -s bash', 'micromamba'],
    ['conda config --add channels bioconda', 'conda'],
    ['sudo rm -rf /root/.ssh', '/root/.ssh']
  ]) {
    assert.equal(protectedShellWrite(command), target, command)
  }
})

test('reading those files and writing elsewhere are not protected writes', () => {
  for (const command of [
    'cat ~/.bashrc',
    'grep conda ~/.bashrc > notes/conda-setup.txt',
    'source ~/.bashrc && nextflow -version',
    'cp ~/.condarc results/condarc.backup',
    'echo done > results/.bashrc',
    'conda env list',
    'conda config --show channels',
    'mkdir -p ~/.cache/phi'
  ]) {
    assert.equal(protectedShellWrite(command), undefined, command)
  }
})

test('the project boundary blocks protected writes without offering approval', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'phi-boundary-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const decision = projectToolBoundaryDecision(project, 'bash', {
    command: 'echo "export PATH=$PATH" >> ~/.bashrc'
  })
  assert.equal(decision.allowed, false)
  assert.equal(!decision.allowed && decision.approvable, false)
  assert.match(
    !decision.allowed ? decision.reason : '',
    /never lets commands change shell profiles/
  )

  const heredoc = projectToolBoundaryDecision(project, 'bash', {
    command: "cat > notes.md <<'EOF'\nRun: echo x >> ~/.bashrc\nEOF"
  })
  assert.deepEqual(heredoc, { allowed: true })
})

test('main sessions and specialists, with or without a project, block protected writes', async () => {
  let handler: ((event: { toolName: string; input: unknown }) => Promise<unknown>) | undefined
  await createRemoteUrlGuardExtension()({
    on(name: string, candidate: typeof handler) {
      if (name === 'tool_call') handler = candidate
    }
  } as never)
  assert.ok(handler)
  const blocked = (await handler({ toolName: 'bash', input: { command: 'conda init zsh' } })) as {
    block: boolean
  }
  assert.equal(blocked.block, true)
  assert.equal(await handler({ toolName: 'bash', input: { command: 'cat ~/.zshrc' } }), undefined)
})
