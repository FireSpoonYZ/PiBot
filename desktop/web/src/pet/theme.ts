export type PetThemePreference = 'light' | 'dark' | 'system';

export function resolvePetTheme(
  raw: string | null | undefined,
  prefersDark: boolean,
): { theme: PetThemePreference; resolved: 'light' | 'dark' } {
  const theme: PetThemePreference =
    raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  const resolved: 'light' | 'dark' =
    theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  return { theme, resolved };
}
