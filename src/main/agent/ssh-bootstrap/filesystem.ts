import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises'

import type { SshHostKeyFileSystem } from './host-key'

export function createNodeSshHostKeyFileSystem(): SshHostKeyFileSystem {
  return {
    async readText(path) {
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.size > 4 * 1024 * 1024) return null
        return await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async ensureDirectory(path, mode) {
      await mkdir(path, { recursive: true, mode })
    },
    async appendText(path, content, mode) {
      try {
        const info = await lstat(path)
        if (!info.isFile()) throw new Error('known_hosts 不是普通文件')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const handle = await open(path, 'a', mode)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
        await handle.chmod(mode)
      } finally {
        await handle.close()
      }
      await chmod(path, mode)
    }
  }
}
