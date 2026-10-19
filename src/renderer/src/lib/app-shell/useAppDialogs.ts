import { useState, type Dispatch, type SetStateAction } from 'react'

import type { SettingsCategory } from '../../components/SettingsDialog'
import type { SessionSummary } from '../sessionTypes'

/**
 * App shell: dialog and overlay state.
 *
 * First slice of the App.tsx split. These flags are pure ownership — nothing here
 * talks to a bridge or derives anything — so they can move out without changing a
 * single call site: every identifier keeps its name and its setter signature.
 *
 * The settings category and the export target belong to the same owner because
 * their lifetime is the dialog's lifetime, not the app's.
 */
export interface AppDialogState {
  isSettingsOpen: boolean
  setIsSettingsOpen: Dispatch<SetStateAction<boolean>>
  settingsCategory: SettingsCategory
  setSettingsCategory: Dispatch<SetStateAction<SettingsCategory>>
  isSessionSearchOpen: boolean
  setIsSessionSearchOpen: Dispatch<SetStateAction<boolean>>
  isNewProjectDialogOpen: boolean
  setIsNewProjectDialogOpen: Dispatch<SetStateAction<boolean>>
  isSkillCatalogOpen: boolean
  setIsSkillCatalogOpen: Dispatch<SetStateAction<boolean>>
  isPhiPluginCatalogOpen: boolean
  setIsPhiPluginCatalogOpen: Dispatch<SetStateAction<boolean>>
  showOnboarding: boolean
  setShowOnboarding: Dispatch<SetStateAction<boolean>>
  showEnvironmentSummary: boolean
  setShowEnvironmentSummary: Dispatch<SetStateAction<boolean>>
  exportTarget: SessionSummary | null
  setExportTarget: Dispatch<SetStateAction<SessionSummary | null>>
  isExportingSession: boolean
  setIsExportingSession: Dispatch<SetStateAction<boolean>>
}

export function useAppDialogs(): AppDialogState {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('general')
  const [isSessionSearchOpen, setIsSessionSearchOpen] = useState(false)
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = useState(false)
  const [isSkillCatalogOpen, setIsSkillCatalogOpen] = useState(false)
  const [isPhiPluginCatalogOpen, setIsPhiPluginCatalogOpen] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showEnvironmentSummary, setShowEnvironmentSummary] = useState(false)
  const [exportTarget, setExportTarget] = useState<SessionSummary | null>(null)
  const [isExportingSession, setIsExportingSession] = useState(false)

  return {
    isSettingsOpen,
    setIsSettingsOpen,
    settingsCategory,
    setSettingsCategory,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    isNewProjectDialogOpen,
    setIsNewProjectDialogOpen,
    isSkillCatalogOpen,
    setIsSkillCatalogOpen,
    isPhiPluginCatalogOpen,
    setIsPhiPluginCatalogOpen,
    showOnboarding,
    setShowOnboarding,
    showEnvironmentSummary,
    setShowEnvironmentSummary,
    exportTarget,
    setExportTarget,
    isExportingSession,
    setIsExportingSession
  }
}
