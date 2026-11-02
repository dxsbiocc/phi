import { declareWorkerHostEntry, isWorkerHostSelector } from '@oh-my-pi/pi-utils/worker-host'

// The compiled kernel's entry. OMP starts its brokers and workers by re-entering the running
// executable with a selector, so each of those processes and threads arrives here first. Both
// branches load lazily to keep a worker from evaluating the graph it doesn't use.
if (isWorkerHostSelector(process.argv[2])) {
  // In a compiled build OMP's CLI module dispatches the selector when it is imported. The top-level
  // await holds this entry open until a worker's inbox is installed, or its first messages are lost.
  await import('@oh-my-pi/pi-coding-agent/cli')
} else {
  // OMP finds its worker threads through this declaration; their source files aren't in the binary.
  declareWorkerHostEntry()
  const { runKernelCommandLine } = await import('../main')
  runKernelCommandLine()
}
