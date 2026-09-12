export function isNotebookFilePath(path: string): boolean {
  return path.trim().toLowerCase().endsWith('.ipynb')
}
