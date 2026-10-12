import { Box, Button, Stack, Typography } from '@mui/material'
import { useState } from 'react'

import type { AppUpdateCheck } from '../../../../../shared/appUpdateTypes'

function resultText(result: AppUpdateCheck): string {
  if (result.status === 'available') {
    return `有新版本 ${result.latestVersion}，当前 ${result.currentVersion}。请下载新版本安装包替换当前应用，数据会保留。`
  }
  if (result.status === 'up-to-date') return `已是最新版本（${result.currentVersion}）。`
  return `检查更新失败：${result.error ?? '未知错误'}`
}

/** Version and manual update check; installing stays manual until the app is signed. */
export function AppUpdateSection({
  initialResult = null
}: {
  initialResult?: AppUpdateCheck | null
}): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<AppUpdateCheck | null>(initialResult)

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setResult(await window.api.checkForAppUpdates())
    } catch (error) {
      setResult({
        status: 'error',
        currentVersion: result?.currentVersion ?? '',
        releasesUrl: result?.releasesUrl ?? '',
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <Box data-phi-app-update-section>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        版本与更新
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="small" variant="outlined" disabled={checking} onClick={() => void check()}>
          {checking ? '正在检查…' : '检查更新'}
        </Button>
        {result?.status === 'available' && (
          <Button
            size="small"
            variant="contained"
            onClick={() => void window.api.openAppReleasesPage(result.releasesUrl)}
          >
            前往下载
          </Button>
        )}
      </Stack>
      <Typography
        variant="caption"
        component="div"
        color={result?.status === 'error' ? 'error.main' : 'text.secondary'}
        sx={{ mt: 0.75 }}
      >
        {result
          ? resultText(result)
          : '从 GitHub Releases 检查新版本。当前版本需要手动下载安装包更新。'}
      </Typography>
    </Box>
  )
}
