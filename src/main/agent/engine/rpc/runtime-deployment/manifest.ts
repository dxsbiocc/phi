import {
  RemoteOmpDeploymentError,
  type RemoteOmpAsset,
  type RemoteOmpManifest,
  type RemoteOmpPlatform
} from './types'

// Official v18.10.3 SHA256SUMS and release asset digests, verified 2026-10-13.
// Change together with the desktop SDK version; never select a moving "latest" release.
export const REMOTE_OMP_MANIFEST: RemoteOmpManifest = Object.freeze({
  version: '18.10.3',
  assets: Object.freeze({
    'linux-x64': Object.freeze({
      url: 'https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/omp-linux-x64',
      sha256: '366ffcda80db57b825921b6ff4b0e5e623bc62cf18478f2828cd8a322fc72ff9'
    }),
    'linux-arm64': Object.freeze({
      url: 'https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/omp-linux-arm64',
      sha256: '7f580e1fe06ebffe16ae46cc6881051aca4980db7f654702feefed5651555862'
    })
  })
})

export function selectRemoteOmpAsset(
  manifest: RemoteOmpManifest,
  desktopVersion: string,
  platform: RemoteOmpPlatform
): { key: 'linux-x64' | 'linux-arm64'; asset: RemoteOmpAsset } {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.version !== desktopVersion) {
    throw new RemoteOmpDeploymentError(
      'UNSUPPORTED_VERSION',
      `No remote OMP release matches desktop version ${desktopVersion}.`
    )
  }
  const arch = ['x86_64', 'x64'].includes(platform.arch)
    ? 'x64'
    : ['aarch64', 'arm64'].includes(platform.arch)
      ? 'arm64'
      : undefined
  if (platform.os.toLowerCase() !== 'linux' || !arch || platform.libc?.name !== 'glibc') {
    throw new RemoteOmpDeploymentError(
      'UNSUPPORTED_PLATFORM',
      `Remote OMP requires Linux x64/arm64 with glibc; detected ${platform.os}/${platform.arch}/${platform.libc?.name ?? 'unknown libc'}.`
    )
  }
  const key = `linux-${arch}` as 'linux-x64' | 'linux-arm64'
  const asset = manifest.assets[key]
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.url.startsWith('https://')) {
    throw new RemoteOmpDeploymentError('INVALID_ARGUMENT', 'Invalid remote OMP release manifest.')
  }
  return { key, asset }
}
