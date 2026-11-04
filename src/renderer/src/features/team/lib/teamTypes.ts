import type {
  TeamSourceStatusView as IpcTeamSourceStatusView,
  TeamSourceView as IpcTeamSourceView
} from '../../../../../shared/teamPackTypes'

export type TeamSourceState = 'healthy' | 'cached' | 'not-member' | 'withdrawn' | 'error'

export interface TeamSourceView extends Omit<IpcTeamSourceView, 'status'> {
  status: IpcTeamSourceStatusView & {
    state: TeamSourceState
    credentialProviders: string[]
  }
}
