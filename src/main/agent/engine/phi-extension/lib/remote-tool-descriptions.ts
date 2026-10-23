export const PHI_REMOTE_READ_DESCRIPTION =
  'Phi remote project read: read one UTF-8 file or list one directory on the selected SSH server, or read an enabled global Skill through skill://. Project paths run on the server; Skill resources are restricted to the loaded Skill root. Raw ssh:// URLs are not supported; line selectors such as path:10-50 match local read syntax.'

export const PHI_REMOTE_BASH_DESCRIPTION =
  'Phi remote project bash: execute a bounded non-interactive Bash command on the selected SSH server with cwd fixed to the project root. A shell command can access paths outside that root. Use Wrapper for long-running Nextflow or Slurm jobs. PTY and async mode are unavailable.'

export const PHI_REMOTE_GLOB_DESCRIPTION =
  'Phi remote project glob: find files on the selected SSH server within the project root. Pass path, hidden, gitignore, and limit as in the local glob tool. Raw ssh:// URLs are not accepted.'

export const PHI_REMOTE_GREP_DESCRIPTION =
  'Phi remote project grep: search file contents on the selected SSH server within the project root. Pass pattern, path, case, gitignore, and skip as in the local grep tool. Raw ssh:// URLs are not accepted.'

export const PHI_REMOTE_WRITE_DESCRIPTION =
  'Phi remote project write: create a UTF-8 file, or replace an existing file that this conversation already read and that has not changed. Pass path and content. Existing directories and special files are refused.'

export const PHI_REMOTE_EDIT_DESCRIPTION =
  'Phi remote project edit (OMP replace mode): change an existing UTF-8 file on the selected SSH server. Read the file first, then pass path, old_string, new_string, and optional replace_all. A changed or unread file is refused.'

export const PHI_REMOTE_DOWNLOAD_DESCRIPTION =
  'Download one public HTTPS file directly from the server into the current SSH project. The server performs the request and write; Phi never downloads through or writes to the local session anchor.'

export const PHI_REMOTE_PRESENT_FILES_DESCRIPTION =
  'Declare existing result files from the current SSH project as final deliverables. Paths are validated on the server and returned as remote preview links; Phi never resolves them against the local session anchor.'

export const PHI_ENV_REQUEST_DESCRIPTION =
  'Ask the user to add conda packages to an environment in this project. On confirmation Phi solves a project environment, installs it, and (in a bound session) switches the session to it. Does not modify the original environment.'

export const PHI_SKILL_RUN_DESCRIPTION =
  "Run one program from an installed skill's scripts/ directory inside that skill's environment. The interpreter is chosen from the script extension. args are passed after the script path. cwd is a project-relative working directory."

export const PHI_LEARN_DESCRIPTION =
  "Record one durable lesson in this project's memory so later sessions start with it: a non-obvious fix, a project convention, or a user preference you confirmed. Write it self-contained (what, when, why). Capture sparingly; one specific lesson beats several vague ones. Never record secrets, credentials, or personal data. The user can review and delete every lesson in Phi's settings. Lessons are stored on this computer only, never on a remote server."

export const NOTEBOOK_TOOL_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'notebook_list',
    'List .ipynb notebooks in the current project or ordinary workspace. Use this before opening or modifying a notebook when the path is unknown.'
  ],
  [
    'notebook_read',
    'Read the current in-memory notebook draft for a workspace notebook. Opens the notebook into the live agent workspace on first use. Cell summaries use one-based cellNumber values for human-facing order; use the stable id field as cellId when editing, deleting, or running a cell.'
  ],
  [
    'notebook_insert_cell',
    'Insert a code, markdown, or raw cell into the live in-memory notebook draft. This does not save to disk until notebook_save is called.'
  ],
  [
    'notebook_update_cell',
    'Replace the source and optionally type of an existing cell in the live in-memory notebook draft. This does not save to disk until notebook_save is called.'
  ],
  [
    'notebook_delete_cell',
    'Delete a cell from the live in-memory notebook draft. This does not save to disk until notebook_save is called.'
  ],
  [
    'notebook_run_cell',
    'Run one code cell through the Phi app-managed Jupyter server for the current project or ordinary workspace and update the live in-memory notebook draft with execution count, outputs, and duration metadata. Do not assume localhost:8888 or ask the user to restart an external JupyterLab; the host app starts or attaches the correct workspace server.'
  ],
  [
    'notebook_save',
    'Save the live in-memory notebook draft back to its .ipynb file. Use after notebook edits that should persist in the workspace.'
  ]
])
