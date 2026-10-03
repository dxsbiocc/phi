import { PhiPluginDetail, type PhiPluginDetailProps } from './components/PhiPluginDetail'
import {
  PhiPluginCatalogContent,
  PhiPluginCatalogDialog,
  type PhiPluginCatalogContentProps,
  type PhiPluginCatalogDialogProps
} from './components/PhiPluginCatalogDialog'
import { PhiPluginSidebar, type PhiPluginSidebarProps } from './components/PhiPluginSidebar'
import type { PhiPluginCatalogEntry } from './lib/phiPluginCatalog'

export { PhiPluginCatalogContent, PhiPluginCatalogDialog, PhiPluginDetail, PhiPluginSidebar }
export type {
  PhiPluginCatalogContentProps,
  PhiPluginCatalogDialogProps,
  PhiPluginCatalogEntry,
  PhiPluginDetailProps,
  PhiPluginSidebarProps
}

/** Page-level resource-tab surface; state is shared with the plugin sidebar by App. */
export function PhiPluginsView(props: PhiPluginDetailProps): React.JSX.Element {
  return <PhiPluginDetail {...props} />
}

export default PhiPluginsView
