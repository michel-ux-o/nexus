import { useEffect, useState } from 'react'
import { resolveTheme, THEME_OPTIONS } from './catalog'
import type { ThemeChoice, ThemeId } from './catalog'

const PREVIEW_EVENT = 'nexus-theme-preview'
let preview: ThemeChoice | null = null

/** Preview is temporary and never changes the saved preference. */
export function setThemePreview(choice: ThemeChoice | null): void {
  preview = choice
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PREVIEW_EVENT))
}

function systemIsDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
}

export function useTheme(choice: ThemeChoice | undefined): ThemeId {
  const [previewChoice, setPreviewChoice] = useState(preview)
  const [systemDark, setSystemDark] = useState(systemIsDark)
  const effectiveChoice = previewChoice ?? choice
  const theme = resolveTheme(effectiveChoice, systemDark)

  useEffect(() => {
    const update = () => setPreviewChoice(preview)
    window.addEventListener(PREVIEW_EVENT, update)
    update()
    return () => window.removeEventListener(PREVIEW_EVENT, update)
  }, [])

  useEffect(() => {
    if (effectiveChoice !== 'system' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [effectiveChoice])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.style.colorScheme = THEME_OPTIONS.find((option) => option.id === theme)?.colorScheme ?? 'dark'
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.appendChild(meta)
    }
    meta.content = getComputedStyle(root).getPropertyValue('--ui-canvas').trim()
  }, [theme])

  return theme
}
