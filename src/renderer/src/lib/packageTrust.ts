import type { PackageTrust } from '../../../shared/packageManagerTypes'

/** User-facing names of registry trust tiers (package contract § 4.1). */
export const PACKAGE_TRUST_LABELS: Record<PackageTrust, string> = {
  builtin: '内置',
  official: '官方',
  imported: '未验证'
}

export const PACKAGE_TRUST_DESCRIPTIONS: Record<PackageTrust, string> = {
  builtin: '随 Phi 安装包一起发布',
  official: '由 Phi 官方签名验证',
  imported: '没有官方签名，来自你选择的目录或文件'
}
