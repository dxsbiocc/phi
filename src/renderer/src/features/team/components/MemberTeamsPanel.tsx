import { useRef, useState } from 'react'
import { Alert, Button, Paper, Stack, Typography } from '@mui/material'
import type { TeamSourceInput, TeamSourcePreview } from '../../../../../shared/teamPackTypes'

import { useUiLanguage } from '../../../lib/i18n'
import type { TeamPackMemberController } from '../hooks/useTeamPackMember'
import { teamCopy } from '../lib/teamCopy'
import { teamErrorText } from '../lib/teamErrors'
import type { TeamSourceView } from '../lib/teamTypes'
import { AddTeamSourceDialogView, type SourceLocationKind } from './AddTeamSourceDialog'
import { MemberIdentityCard } from './MemberIdentityCard'
import { PassphraseDialog, type PassphraseDialogKind } from './PassphraseDialog'
import { RemoveTeamSourceDialog } from './RemoveTeamSourceDialog'
import { TeamSourceList } from './TeamSourceList'

type MemberNotice =
  'sourceAdded' | 'sourceRemoved' | 'memberBackupImported' | 'memberBackupExported'

// eslint-disable-next-line max-lines-per-function -- one coordinator preserves dialog drafts across live language changes
export function MemberTeamsPanel({
  controller
}: {
  controller: TeamPackMemberController
}): React.JSX.Element {
  useUiLanguage()
  const [addOpen, setAddOpen] = useState(false)
  const [locationKind, setLocationKind] = useState<SourceLocationKind>('directory')
  const [locationValue, setLocationValue] = useState('')
  const [fingerprint, setFingerprint] = useState('')
  const [preview, setPreview] = useState<TeamSourcePreview | null>(null)
  const [removeTarget, setRemoveTarget] = useState<TeamSourceView | null>(null)
  const [backupKind, setBackupKind] = useState<PassphraseDialogKind | null>(null)
  const [notice, setNotice] = useState<MemberNotice | null>(null)
  const previewRequest = useRef(0)

  function sourceInput(): TeamSourceInput {
    return {
      fingerprint: fingerprint.trim(),
      location:
        locationKind === 'directory'
          ? { kind: 'directory', path: locationValue.trim() }
          : { kind: 'https', url: locationValue.trim() }
    }
  }

  function closeAdd(): void {
    previewRequest.current += 1
    setAddOpen(false)
    setPreview(null)
    controller.clearError()
  }

  function invalidatePreview(): void {
    previewRequest.current += 1
    setPreview(null)
  }

  const error = teamErrorText(controller.errorCode)
  return (
    <Stack spacing={2}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}
      >
        <div>
          <Typography variant="h5">{teamCopy.joinedTeams}</Typography>
          <Typography variant="body2" color="text.secondary">
            {teamCopy.joinedTeamsHint}
          </Typography>
        </div>
        <Button variant="contained" onClick={() => setAddOpen(true)}>
          {teamCopy.addTeam}
        </Button>
      </Stack>
      {error && !addOpen && !backupKind ? <Alert severity="error">{error}</Alert> : null}
      {notice ? <Alert severity="success">{teamCopy[notice]}</Alert> : null}
      <MemberIdentityCard
        recipient={controller.recipient}
        errorCode={!controller.recipient ? controller.errorCode : null}
        onCopy={() => {
          if (controller.recipient) void navigator.clipboard.writeText(controller.recipient)
        }}
        onExport={() => setBackupKind('member-export')}
        onImport={() => setBackupKind('member-import')}
      />
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
        {controller.sources.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {controller.busy === 'load-member' ? teamCopy.loading : teamCopy.noTeamSources}
          </Typography>
        ) : (
          <TeamSourceList
            sources={controller.sources}
            busySourceId={controller.busy}
            onCheck={(source) => void controller.checkSource(source.id)}
            onRemove={setRemoveTarget}
          />
        )}
      </Paper>
      <AddTeamSourceDialogView
        open={addOpen}
        locationKind={locationKind}
        locationValue={locationValue}
        fingerprint={fingerprint}
        preview={preview}
        busy={
          controller.busy === 'pick-source'
            ? 'pick'
            : controller.busy === 'preview-source'
              ? 'preview'
              : controller.busy === 'add-source'
                ? 'save'
                : null
        }
        errorCode={controller.errorCode}
        onLocationKindChange={(kind) => {
          invalidatePreview()
          setLocationKind(kind)
          setLocationValue('')
        }}
        onLocationValueChange={(value) => {
          invalidatePreview()
          setLocationValue(value)
        }}
        onFingerprintChange={(value) => {
          invalidatePreview()
          setFingerprint(value)
        }}
        onPickDirectory={() => {
          void controller.pickDirectory().then((path) => {
            if (path) {
              invalidatePreview()
              setLocationValue(path)
            }
          })
        }}
        onPreview={() => {
          const request = ++previewRequest.current
          const input = sourceInput()
          void controller.previewSource(input).then((result) => {
            if (previewRequest.current === request) setPreview(result)
          })
        }}
        onSave={() => {
          if (!preview) return
          const confirmedInput: TeamSourceInput = {
            location: preview.location,
            fingerprint: preview.publicKeyFingerprint
          }
          void controller.addSource(confirmedInput).then((saved) => {
            if (saved) {
              setNotice('sourceAdded')
              closeAdd()
            }
          })
        }}
        onClose={closeAdd}
      />
      <RemoveTeamSourceDialog
        source={removeTarget}
        busy={Boolean(removeTarget && controller.busy === `remove:${removeTarget.id}`)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (!removeTarget) return
          void controller.removeSource(removeTarget.id).then((removed) => {
            if (removed) {
              setRemoveTarget(null)
              setNotice('sourceRemoved')
            }
          })
        }}
      />
      <PassphraseDialog
        open={backupKind !== null}
        kind={backupKind ?? 'member-export'}
        busy={controller.busy === backupKind}
        errorCode={controller.errorCode}
        onClose={() => setBackupKind(null)}
        onSubmit={(passphrase) => {
          const operation =
            backupKind === 'member-import' ? controller.importBackup : controller.exportBackup
          void operation(passphrase).then((completed) => {
            if (!completed) return
            setNotice(
              backupKind === 'member-import' ? 'memberBackupImported' : 'memberBackupExported'
            )
            setBackupKind(null)
          })
        }}
      />
    </Stack>
  )
}
