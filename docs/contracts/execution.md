# Execution contract

contractVersion: 1.0.0

This contract defines what "run a process in a managed environment" means in Phi. It is the
only way the engine runs content (skill scripts, script tools, plugin and specialist agents'
commands, MCP stdio servers, notebook kernels, Nextflow). See
[runtime foundation](../design/phi-runtime-foundation.md) §4 and the
[environment contract](environment.md).

The main agent's `bash` is not covered: it keeps the host environment by design.

## API

```ts
environmentVariables(env: EnvHandle, options?: ExecutionOptions): Record<string, string>
runInEnvironment(env: EnvHandle, argv: string[], options: RunOptions): Promise<RunResult>
loadEnvironment(root: string, envId: string): EnvHandle   // reads and validates env.json
```

`EnvHandle` contains `{ envId, prefix, metadata }` and the bound runtime for a WSL2
environment, as returned by `ensureEnvironment`. Resolving
references such as `phi:python@1` into a handle is not part of this contract (it belongs to
`skill_run` and agent binding).

`environmentVariables` is for consumers that start processes themselves (MCP stdio servers,
Jupyter kernels, the Nextflow executor); `runInEnvironment` runs a command directly.

## Variables

A child process never inherits the Phi process environment. Its variables are built from four
sources, in this order (later sources win):

1. **Kept host variables** — only these names, copied when present in the host environment:
   `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `TERM`, `TZ`, `LANG`, every `LC_*`,
   `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase forms, `SSL_CERT_FILE`,
   `REQUESTS_CA_BUNDLE`, `SSH_AUTH_SOCK`. Every other host variable is dropped, including
   `PATH`, `PYTHONPATH`, `PYTHONHOME`, `VIRTUAL_ENV`, `CONDA_*`, `MAMBA_*`, `R_*`,
   `JAVA_HOME`, `PERL5LIB`, `NODE_PATH`, `LD_LIBRARY_PATH`, and `DYLD_*`.
2. **Activation snapshot** — `metadata.activation.set` from `env.json`.
3. **Phi isolation variables** — always set:
   | Variable                                                                                  | Value                    | Why                                                             |
   | ----------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
   | `PYTHONNOUSERSITE`                                                                        | `1`                      | ignore the user site-packages                                   |
   | `PYTHONDONTWRITEBYTECODE`                                                                 | `1`                      | the prefix is read-only; avoid failed writes                    |
   | `R_LIBS_USER`                                                                             | `<prefix>/lib/R/library` | no user library; R deduplicates the entry                       |
   | `R_LIBS_SITE`                                                                             | `<prefix>/lib/R/library` | same for site libraries                                         |
   | `R_PROFILE_USER`                                                                          | `/dev/null`              | ignore `~/.Rprofile`                                            |
   | `R_ENVIRON_USER`                                                                          | `/dev/null`              | ignore `~/.Renviron`                                            |
   | `MPLBACKEND`                                                                              | `Agg`                    | headless plotting                                               |
   | `MPLCONFIGDIR`                                                                            | `<cache>/matplotlib`     | ignore `~/.config/matplotlib`; writable font cache              |
   | `NUMBA_CACHE_DIR`                                                                         | `<cache>/numba`          | numba cannot cache inside a read-only prefix and would raise    |
   | `XDG_CACHE_HOME`                                                                          | `<cache>/xdg`            | other tools' caches stay out of the prefix and the user's cache |
   | `PHI_ENV_ID`                                                                              | `envId`                  | lets scripts and logs report the environment                    |
   | `PHI_ENV_PREFIX`                                                                          | `prefix`                 |                                                                 |
   | `<cache>` is `<runtime root>/cache/<envId>/`, created on demand, writable, and removed by |
   | garbage collection together with the environment.                                         |
4. **Locale default** — when none of `LC_ALL`, `LC_CTYPE`, `LANG` names a UTF-8 locale, set
   `LC_ALL` to `en_US.UTF-8` on macOS and `C.UTF-8` on Linux.

Native Windows environment names are compared case-insensitively. Windows also
keeps the platform's system, profile, temp, and executable lookup variables and
uses `NUL` for the R profile files and `PYTHONUTF8=1` for Python. A WSL2 process
gets Linux paths and a guest-owned cache. The Windows proxy and the guest process
both start with restricted environments.

`options.extraEnv` (caller-supplied, e.g. `OMICS_VISUALIZATION_SKILL_ROOT`) is applied last but
may not set `PATH`, any `PYTHON*`, `R_*`, `CONDA_*`, `MAMBA_*`, `LD_*`, `DYLD_*`, or the
`PHI_ENV_*` names above; such keys are rejected with an error.

## PATH

`PATH` is, in order:

1. the entries of `metadata.activation.pathPrepend` that are inside the prefix (the
   environment's `bin` first); entries outside it, such as the runtime `condabin` that
   `micromamba run` adds, are dropped;
2. the directories of the host dependencies recorded in `metadata.host` (for example the
   directory containing `soffice`), deduplicated;
3. `/usr/bin:/bin:/usr/sbin:/sbin` on Unix, or `%SystemRoot%\System32` and
   `%SystemRoot%` on native Windows. Windows uses `;` and keeps the environment's
   activated DLL directories in their original order.

It never contains the user's conda, Homebrew, pyenv, `~/.local/bin`, or any other host
directory.

## Running

- Native execution resolves `argv[0]` against the constructed `PATH` or checks
  the supplied path. An unresolved command fails before launch. In WSL2, the
  guest resolves the translated command against its isolated Linux `PATH`.
- No shell is involved: arguments are passed as an array.
- `options.cwd` is required and must be an existing directory.
- `options.timeoutMs` and `options.signal` terminate the child. Unix sends SIGTERM
  to the process group, then SIGKILL after 5 s. Native Windows terminates the
  child through Windows, and WSL2 sends termination to the owned Linux process
  group. The result has `exitCode: null` and `terminated: 'timeout' | 'aborted'`.
- `options.onOutput` receives `{ stream: 'stdout' | 'stderr', text }` chunks as they arrive.
- `options.stdin` (string) is written to the child and closed.
- Captured `stdout` and `stderr` are each limited to `options.maxOutputBytes` (default 1 MiB);
  beyond that the text is truncated at the end and `truncated.stdout` / `truncated.stderr` is
  `true`. Streaming via `onOutput` is not truncated.

## Result

```ts
interface RunResult {
  envId: string
  argv: string[]
  resolvedCommand: string // native absolute path or command passed to WSL
  cwd: string
  exitCode: number | null
  signal: string | null
  terminated?: 'timeout' | 'aborted'
  stdout: string
  stderr: string
  truncated: { stdout: boolean; stderr: boolean }
  durationMs: number
}
```

Callers that keep run records (`wrappers/reproducibility.ts` and equivalents) store `envId`,
`resolvedCommand`, and `argv`.

## Guarantees and their tests

Isolation is a tested property, not a convention. The conformance suite
(`npm run test:runtime`) must show, for a real environment built from a lock:

1. the interpreter (`sys.executable`, `sys.prefix`; R `R.home()`) is inside the prefix;
2. a module importable only through the host (via `PYTHONPATH`, the user site, or an R user
   library / `~/.Rprofile`) is **not** importable under `runInEnvironment`;
3. `numba` / `matplotlib` style caches land in `<cache>`, not in the prefix or `$HOME`;
4. the same results on a clean CI machine with no host Python or R.

The Windows CI smoke builds the official Python and Jupyter locks on Windows x64,
checks prefix reuse, and executes a scientific Python cell through the managed
Notebook. WSL2 acceptance uses a Windows machine with an initialized distribution.
Windows WSL2 environments are available to managed Notebook kernels, script
tools, and Conda-profile Nextflow jobs. Binding an agent shell to a WSL2
environment is rejected. Host Notebook kernels and managed stdio MCP launch
remain outside the Windows acceptance scope.

## Versioning

`contractVersion` follows the rules in the content distribution design §4.4: minor versions are
additive only (new optional options, new result fields, new isolation variables that do not
change behaviour for existing content); anything else needs an ADR and a deprecation window.
