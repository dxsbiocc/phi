export const missingToolPromptEnglish = {
  requiredToolNotFound: 'Required tool not found',
  requiredToolNotFoundValue: (tool: string) => `Required tool not found: ${tool}`,
  phiNeedsThisToolBeforeThePausedActionCanContinue:
    'Phi needs this tool before the paused action can continue.',
  requiredTool: 'Required tool',
  foundCandidates: 'Found candidates',
  noCandidatesFound: 'No candidates were found. Enter a path instead.',
  chooseCandidate: 'Choose candidate',
  useSelectedCandidate: 'Use selected candidate',
  enterAPath: 'Enter a path',
  environmentFolderOrAbsoluteExecutablePath: 'Environment folder or absolute executable path',
  pathHelp: 'Enter an environment or installation folder, or the absolute path to the executable.',
  useThisPath: 'Use this path',
  pathNotAccepted: (path: string) => `The path ${path} was not accepted.`,
  rejectReason: {
    'path-must-be-absolute': 'Enter an absolute path that starts with /.',
    'invalid-path': 'The path contains characters Phi cannot use.',
    'not-executable':
      'There is no executable at this path, and the folder has no bin/ entry for the tool.',
    'host-check-failed': 'The server did not answer the check in time. Try again.',
    'no-version': 'The executable did not report a version when Phi ran it.',
    'java-too-old': 'Nextflow needs Java 17 or newer in the same environment.'
  },
  installANewEnvironment: 'Install a new environment',
  installIsNeverAutomatic:
    'Phi installs only after you review this summary and confirm. Your own Conda environments are not changed.',
  environment: 'Environment',
  what: 'What',
  where: 'Where',
  approximateSize: 'Approximate size',
  reviewInstallation: 'Review installation',
  confirmInstallation: 'Confirm installation',
  back: 'Back',
  cancel: 'Cancel',
  source: {
    saved: 'Saved path',
    path: 'Login PATH',
    conda: 'Conda environment',
    micromamba: 'Micromamba environment',
    phi: 'Phi-managed environment',
    common: 'Common location'
  }
} as const
