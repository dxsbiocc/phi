import type {
  FeaturedMcpConnector,
  LocalMcpConnectorRequest,
  RemoteMcpConnectorOptions
} from '../../../../../shared/mcpConnectorCatalog'
import type {
  GithubLocalConnectorDraft,
  GithubSourceSummary
} from '../../../../../shared/githubSourceTypes'
import type { LocalConnectorInitialDraft } from '../lib/localConnectorDraft'
import { McpApiKeyDialog } from './McpApiKeyDialog'
import { McpCustomConnectorDialog } from './McpCustomConnectorDialog'
import { McpGithubImportDialog } from './McpGithubImportDialog'
import { McpImportedInstallDialog } from './McpImportedInstallDialog'
import { McpSourcesPanel } from './McpSourcesPanel'

interface McpCatalogAuxiliaryDialogsProps {
  customOpen: boolean
  busy: boolean
  authorizingCustom: boolean
  customError: string | null
  localAvailable: boolean
  initialDraft?: LocalConnectorInitialDraft
  onCloseCustom: () => void
  onSubmitRemote: (name: string, url: string, options?: RemoteMcpConnectorOptions) => void
  onSubmitLocal: (request: LocalMcpConnectorRequest) => Promise<void>
  githubImportOpen: boolean
  onCloseGithub: () => void
  onGithubImported: (source: GithubSourceSummary) => Promise<void>
  onUseLocalDraft: (draft: GithubLocalConnectorDraft) => void
  sourcesOpen: boolean
  onCloseSources: () => void
  onSourcesChanged: () => Promise<void>
  pendingImportedConnector: FeaturedMcpConnector | null
  onCancelImported: () => void
  onConfirmImported: () => void
  apiKeyConnector: FeaturedMcpConnector | null
  apiKeyInput: string
  apiKeyVerified: boolean
  apiKeyInstalled: boolean
  apiKeyError: string | null
  onApiKeyChange: (value: string) => void
  onCloseApiKey: () => void
  onSubmitApiKey: () => void
}

export function McpCatalogAuxiliaryDialogs(
  props: McpCatalogAuxiliaryDialogsProps
): React.JSX.Element {
  return (
    <>
      {props.customOpen && (
        <McpCustomConnectorDialog
          open
          busy={props.busy}
          authorizing={props.authorizingCustom}
          error={props.customError}
          localAvailable={props.localAvailable}
          initialDraft={props.initialDraft}
          onClose={props.onCloseCustom}
          onSubmit={props.onSubmitRemote}
          onSubmitLocal={props.onSubmitLocal}
        />
      )}
      {props.githubImportOpen && (
        <McpGithubImportDialog
          open
          onClose={props.onCloseGithub}
          onImported={props.onGithubImported}
          onUseLocalDraft={props.onUseLocalDraft}
        />
      )}
      {props.sourcesOpen && (
        <McpSourcesPanel open onClose={props.onCloseSources} onChanged={props.onSourcesChanged} />
      )}
      <McpImportedInstallDialog
        connector={props.pendingImportedConnector}
        open={Boolean(props.pendingImportedConnector)}
        busy={props.busy}
        onCancel={props.onCancelImported}
        onConfirm={props.onConfirmImported}
      />
      <McpApiKeyDialog
        connector={props.apiKeyConnector}
        value={props.apiKeyInput}
        verified={props.apiKeyVerified}
        installed={props.apiKeyInstalled}
        busy={props.busy}
        error={props.apiKeyError}
        onChange={props.onApiKeyChange}
        onClose={props.onCloseApiKey}
        onSubmit={props.onSubmitApiKey}
      />
    </>
  )
}
