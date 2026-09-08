import { copyFileSync, existsSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const electronApp = join(root, 'node_modules/electron/dist/Electron.app')
const plist = join(electronApp, 'Contents/Info.plist')
const sourceIcon = join(root, 'build/icon.icns')
const targetIcon = join(electronApp, 'Contents/Resources/electron.icns')

if (process.platform !== 'darwin' || !existsSync(electronApp)) {
  process.exit(0)
}

if (!existsSync(sourceIcon)) {
  throw new Error(`Missing app icon: ${sourceIcon}`)
}

copyFileSync(sourceIcon, targetIcon)

const plistUpdates = [
  ['CFBundleDisplayName', 'Phi'],
  ['CFBundleName', 'Phi'],
  ['CFBundleIdentifier', 'com.electron.app']
]

for (const [key, value] of plistUpdates) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist], {
    stdio: 'inherit'
  })
}

const now = new Date()
utimesSync(targetIcon, now, now)
utimesSync(plist, now, now)
utimesSync(electronApp, now, now)

console.log('Synced Phi icon into Electron dev app.')
