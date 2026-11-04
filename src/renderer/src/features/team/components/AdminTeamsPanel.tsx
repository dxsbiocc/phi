import { useState } from 'react'
import { Alert, Button, Paper, Stack, Typography } from '@mui/material'
import type {
  TeamAdminMember,
  TeamAdminModelInput,
  TeamAdminRelease,
  TeamPackageSelection,
  TeamResourceSharing
} from '../../../../../shared/teamPackTypes'

import { useUiLanguage } from '../../../lib/i18n'
import { useTeamPackAdmin } from '../hooks/useTeamPackAdmin'
import { teamCopy } from '../lib/teamCopy'
import { teamErrorText } from '../lib/teamErrors'
import { packageSelectionKey } from '../lib/teamPackages'
import { AddAdminMemberDialogView, RemoveAdminMemberDialog } from './AdminMemberDialogs'
import { AdminMembersSection } from './AdminMembersSection'
import { AdminSubmissionsSection } from './AdminSubmissionsSection'
import { AdminTeamList, CreatedTeamBackupDialog } from './AdminTeamList'
import { CreateTeamDialog } from './CreateTeamDialog'
import { MemberModelsDialogView } from './MemberModelsDialog'
import { PassphraseDialog, type PassphraseDialogKind } from './PassphraseDialog'
import { ReleaseHistorySection, WithdrawReleaseDialog } from './ReleaseHistorySection'
import { TeamPublishSection } from './TeamPublishSection'

const emptyModel = (): TeamAdminModelInput => ({ providerId: '', label: '', apiKey: '' })

type AdminNotice =
  | 'memberAdded'
  | 'memberRemoved'
  | 'modelsSaved'
  | 'adminBackupImported'
  | 'adminBackupExported'
  | 'submissionAccepted'
  | 'submissionImported'
  | 'submissionDeleted'

// eslint-disable-next-line max-lines-per-function -- one coordinator preserves dialog drafts across live language changes
export function AdminTeamsPanel(): React.JSX.Element {
  useUiLanguage()
  const controller = useTeamPackAdmin()
  const [createOpen, setCreateOpen] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [backupKind, setBackupKind] = useState<PassphraseDialogKind | null>(null)
  const [backupTeamId, setBackupTeamId] = useState<string | null>(null)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [memberName, setMemberName] = useState('')
  const [memberRecipient, setMemberRecipient] = useState('')
  const [removeMember, setRemoveMember] = useState<TeamAdminMember | null>(null)
  const [modelsMember, setModelsMember] = useState<TeamAdminMember | null>(null)
  const [models, setModels] = useState<TeamAdminModelInput[]>([])
  const [selectedPackages, setSelectedPackages] = useState<string[]>([])
  const [deselectedPendingPackages, setDeselectedPendingPackages] = useState<string[]>([])
  const [sharingByPackage, setSharingByPackage] = useState<Record<string, TeamResourceSharing>>({})
  const [announcement, setAnnouncement] = useState('')
  const [withdrawRelease, setWithdrawRelease] = useState<TeamAdminRelease | null>(null)
  const [notice, setNotice] = useState<AdminNotice | null>(null)

  const publishPackages = [
    ...controller.packages,
    ...(controller.detail?.pendingSubmissionPackages ?? [])
  ]
  const availablePackageKeys = new Set(publishPackages.map(packageSelectionKey))
  const pendingPackageKeys = (controller.detail?.pendingSubmissionPackages ?? []).map(
    packageSelectionKey
  )
  const effectiveSelectedPackages = [
    ...new Set([
      ...selectedPackages.filter((key) => availablePackageKeys.has(key)),
      ...pendingPackageKeys.filter((key) => !deselectedPendingPackages.includes(key))
    ])
  ]

  function openModels(member: TeamAdminMember): void {
    const existing =
      controller.detail?.modelGrants.find((entry) => entry.memberId === member.memberId)?.models ??
      []
    setModelsMember(member)
    setModels(
      existing.length ? existing.map((model) => ({ ...model, apiKey: '' })) : [emptyModel()]
    )
  }

  function selections(): TeamPackageSelection[] {
    const selected = new Set(effectiveSelectedPackages)
    return publishPackages
      .filter((entry) => {
        if (!selected.has(packageSelectionKey(entry))) return false
        const source = 'teamSource' in entry ? entry.teamSource : undefined
        return (
          source === undefined ||
          source.teamId === controller.detail?.teamId ||
          source.sharing === 'forwardable'
        )
      })
      .map((entry) => {
        const pendingSubmissionId = 'submissionId' in entry ? entry.submissionId : undefined
        return {
          type: entry.type,
          id: entry.id,
          sharing: sharingByPackage[packageSelectionKey(entry)] ?? 'team-only',
          ...(pendingSubmissionId ? { pendingSubmissionId } : {})
        }
      })
  }

  function resetTeamScopedState(): void {
    setAddMemberOpen(false)
    setMemberName('')
    setMemberRecipient('')
    setRemoveMember(null)
    setModelsMember(null)
    setModels([])
    setSelectedPackages([])
    setDeselectedPendingPackages([])
    setSharingByPackage({})
    setAnnouncement('')
    setWithdrawRelease(null)
    setNotice(null)
  }

  const error = teamErrorText(controller.errorCode)
  return (
    <Stack spacing={2}>
      {error && !backupKind ? <Alert severity="error">{error}</Alert> : null}
      {notice ? <Alert severity="success">{teamCopy[notice]}</Alert> : null}
      <AdminTeamList
        teams={controller.teams}
        selectedTeamId={controller.detail?.teamId ?? null}
        onSelect={(team) => {
          resetTeamScopedState()
          void controller.selectTeam(team.teamId)
        }}
        onCreate={() => setCreateOpen(true)}
        onRestore={() => setBackupKind('admin-import')}
        onCopyFingerprint={(fingerprint) => void navigator.clipboard.writeText(fingerprint)}
      />
      {controller.detail ? (
        <>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
            <Stack spacing={1}>
              <Typography variant="h5">{controller.detail.name}</Typography>
              <Typography component="code" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {controller.detail.publicKeyFingerprint}
              </Typography>
              <Button
                variant="outlined"
                onClick={() => {
                  setBackupTeamId(controller.detail!.teamId)
                  setBackupKind('admin-export')
                }}
              >
                {teamCopy.backupSigningKeyNow}
              </Button>
            </Stack>
          </Paper>
          <AdminMembersSection
            members={controller.detail.members}
            modelGrants={controller.detail.modelGrants}
            onAdd={() => setAddMemberOpen(true)}
            onEditModels={openModels}
            onRemove={setRemoveMember}
          />
          <AdminSubmissionsSection
            submissions={controller.submissions}
            busy={controller.busy !== null}
            onRefresh={() => void controller.refreshSubmissions()}
            onImport={() => {
              void controller.importSubmission().then((imported) => {
                if (imported) setNotice('submissionImported')
              })
            }}
            onAccept={(submission) => {
              void controller.acceptSubmission(submission.entryId).then((accepted) => {
                if (accepted) setNotice('submissionAccepted')
              })
            }}
            onDelete={(submission) => {
              void controller.deleteSubmission(submission.entryId).then((deleted) => {
                if (deleted) setNotice('submissionDeleted')
              })
            }}
          />
          <TeamPublishSection
            storeDir={controller.detail.storeDir}
            teamId={controller.detail.teamId}
            latestRelease={controller.detail.latestRelease}
            packages={publishPackages}
            selected={effectiveSelectedPackages}
            sharingByKey={sharingByPackage}
            announcement={announcement}
            busy={controller.busy === 'publish'}
            published={controller.published}
            onToggle={(entry) => {
              const key = packageSelectionKey(entry)
              if ('submissionId' in entry) {
                setDeselectedPendingPackages((current) =>
                  effectiveSelectedPackages.includes(key)
                    ? [...current.filter((value) => value !== key), key]
                    : current.filter((value) => value !== key)
                )
              } else if (selectedPackages.includes(key)) {
                setSelectedPackages((current) => current.filter((value) => value !== key))
                setSharingByPackage((sharing) => {
                  const next = { ...sharing }
                  delete next[key]
                  return next
                })
              } else {
                setSelectedPackages((current) => [...current, key])
                setSharingByPackage((sharing) => ({ ...sharing, [key]: 'team-only' }))
              }
            }}
            onSharingChange={(entry, sharing) =>
              setSharingByPackage((current) => ({
                ...current,
                [packageSelectionKey(entry)]: sharing
              }))
            }
            onAnnouncementChange={setAnnouncement}
            onPublish={() => {
              const text = announcement.trim().length > 0 ? announcement : undefined
              void controller.publish(selections(), text).then((published) => {
                if (published) setAnnouncement('')
              })
            }}
            onAnnounceOnly={() => {
              void controller.announceOnly(announcement).then((published) => {
                if (published) setAnnouncement('')
              })
            }}
          />
          <ReleaseHistorySection
            releases={controller.detail.releases}
            onWithdraw={setWithdrawRelease}
          />
        </>
      ) : null}
      <CreateTeamDialog
        open={createOpen}
        name={teamName}
        busy={controller.busy === 'create-team'}
        onNameChange={setTeamName}
        onClose={() => setCreateOpen(false)}
        onSubmit={() => {
          void controller.createTeam(teamName.trim()).then((created) => {
            if (created) {
              resetTeamScopedState()
              setCreateOpen(false)
              setTeamName('')
            }
          })
        }}
      />
      <CreatedTeamBackupDialog
        team={controller.createdTeam}
        onCopy={() => {
          if (controller.createdTeam) {
            void navigator.clipboard.writeText(controller.createdTeam.publicKeyFingerprint)
          }
        }}
        onExport={() => {
          setBackupTeamId(controller.createdTeam?.teamId ?? null)
          controller.setCreatedTeam(null)
          setBackupKind('admin-export')
        }}
        onClose={() => controller.setCreatedTeam(null)}
      />
      <AddAdminMemberDialogView
        open={addMemberOpen}
        displayName={memberName}
        recipient={memberRecipient}
        busy={controller.busy === 'add-member'}
        errorCode={controller.errorCode}
        onDisplayNameChange={setMemberName}
        onRecipientChange={setMemberRecipient}
        onClose={() => setAddMemberOpen(false)}
        onSubmit={() => {
          void controller.addMember(memberName.trim(), memberRecipient.trim()).then((added) => {
            if (!added) return
            setAddMemberOpen(false)
            setMemberName('')
            setMemberRecipient('')
            setNotice('memberAdded')
          })
        }}
      />
      <RemoveAdminMemberDialog
        member={removeMember}
        busy={controller.busy === 'remove-member'}
        onClose={() => setRemoveMember(null)}
        onConfirm={() => {
          if (!removeMember) return
          void controller.removeMember(removeMember.memberId).then((removed) => {
            if (!removed) return
            setRemoveMember(null)
            setNotice('memberRemoved')
          })
        }}
      />
      <MemberModelsDialogView
        open={modelsMember !== null}
        memberName={modelsMember?.displayName ?? ''}
        models={models}
        busy={controller.busy === 'save-models'}
        errorCode={controller.errorCode}
        onAdd={() => setModels((current) => [...current, emptyModel()])}
        onRemove={(index) => setModels((current) => current.filter((_, row) => row !== index))}
        onChange={(index, model) =>
          setModels((current) => current.map((entry, row) => (row === index ? model : entry)))
        }
        onClose={() => {
          setModels([])
          setModelsMember(null)
        }}
        onSubmit={() => {
          if (!modelsMember) return
          void controller.setMemberModels(modelsMember.memberId, models).then((saved) => {
            if (!saved) return
            setModels([])
            setModelsMember(null)
            setNotice('modelsSaved')
          })
        }}
      />
      <WithdrawReleaseDialog
        release={withdrawRelease}
        busy={controller.busy === 'withdraw'}
        onClose={() => setWithdrawRelease(null)}
        onConfirm={() => {
          if (!withdrawRelease) return
          void controller.withdraw(withdrawRelease.release).then((withdrawn) => {
            if (withdrawn) setWithdrawRelease(null)
          })
        }}
      />
      <PassphraseDialog
        open={backupKind !== null}
        kind={backupKind ?? 'admin-export'}
        busy={controller.busy === backupKind}
        errorCode={controller.errorCode}
        onClose={() => setBackupKind(null)}
        onSubmit={(passphrase) => {
          const operation =
            backupKind === 'admin-import'
              ? controller.importBackup(passphrase)
              : backupTeamId
                ? controller.exportBackup(backupTeamId, passphrase)
                : Promise.resolve(false)
          void operation.then((completed) => {
            if (!completed) return
            if (backupKind === 'admin-import') resetTeamScopedState()
            setNotice(backupKind === 'admin-import' ? 'adminBackupImported' : 'adminBackupExported')
            setBackupKind(null)
          })
        }}
      />
    </Stack>
  )
}
