export function officeTestHooksEnabled(
  isPackaged: boolean,
  environment: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return !isPackaged && environment.PHI_OFFICE_TEST_HOOKS === '1'
}
