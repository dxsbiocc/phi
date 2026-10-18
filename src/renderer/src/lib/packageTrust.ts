import type { PackageTrust } from '../../../shared/packageManagerTypes'
import { resourceTrustCopy, resourceUi } from './resourceUi'

/** User-facing names of registry trust tiers (package contract § 4.1). */
export const PACKAGE_TRUST_LABELS: Record<PackageTrust, string> = {
  get builtin() {
    return resourceUi.builtIn
  },
  get official() {
    return resourceUi.officialVerified
  },
  get imported() {
    return resourceUi.unsigned
  }
}

export const PACKAGE_TRUST_DESCRIPTIONS: Record<PackageTrust, string> = {
  get builtin() {
    return resourceTrustCopy.builtinDescription
  },
  get official() {
    return resourceTrustCopy.officialDescription
  },
  get imported() {
    return resourceTrustCopy.importedDescription
  }
}
