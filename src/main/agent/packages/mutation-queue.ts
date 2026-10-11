let tail: Promise<unknown> = Promise.resolve()

/**
 * Package installs, updates and removals read, change and rewrite shared registries (skills.json,
 * the wrapper tree), so two at once could lose each other's update. Running them through one queue
 * lets the UI start several without waiting on each other.
 */
export function runPackageMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task)
  tail = run.catch(() => undefined)
  return run
}
