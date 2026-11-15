export type ThemeId = 'nexus' | 'daylight' | 'sand' | 'aurora'
export type ThemeChoice = ThemeId | 'system'

export const THEME_OPTIONS: { id: ThemeId; name: string; description: string; colorScheme: 'light' | 'dark' }[] = [
  { id: 'nexus', name: 'Nexus', description: 'Graphit und tiefes Blau mit sparsamem Eisblau', colorScheme: 'dark' },
  { id: 'daylight', name: 'Tageslicht', description: 'Hell und klar mit blauem Akzent', colorScheme: 'light' },
  { id: 'sand', name: 'Sand', description: 'Warm und hell mit ockerfarbenem Akzent', colorScheme: 'light' },
  { id: 'aurora', name: 'Nordlicht', description: 'Dunkel mit türkisem Akzent', colorScheme: 'dark' },
]

export function resolveTheme(choice: unknown, systemDark: boolean): ThemeId {
  if (choice === 'system') return systemDark ? 'nexus' : 'daylight'
  return THEME_OPTIONS.some((option) => option.id === choice) ? choice as ThemeId : 'nexus'
}

