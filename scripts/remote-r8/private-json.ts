import { lstat, readFile } from 'node:fs/promises'

/** Reads a small JSON file only when it is a private regular file owned by this user. */
export async function readPrivateJson(path: string): Promise<unknown> {
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    stat.size > 65_536 ||
    stat.mode & 0o077
  )
    throw new Error('Workflow input is not private')
  return JSON.parse(await readFile(path, 'utf8'))
}
