const TRANSLITERATIONS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
};

/**
 * Leitet aus einem Projektnamen einen git-tauglichen Slug ab
 * (z. B. "Mein Dashboard!" → "mein-dashboard"). Kann leer sein,
 * wenn der Name keine verwertbaren Zeichen enthält.
 */
export function deriveBranchSlug(name: string): string {
  const lowered = name.toLowerCase();
  const transliterated = [...lowered].map((ch) => TRANSLITERATIONS[ch] ?? ch).join('');
  return transliterated
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Branch-Name im Schema `<username>/<slug>` (z. B. "marco/dashboard"). */
export function buildBranchName(username: string, slug: string): string {
  return `${username}/${slug}`;
}

/**
 * Löst Slug-Kollisionen innerhalb eines Users durch numerisches Suffix auf:
 * "dashboard" → "dashboard-2" → "dashboard-3" …
 */
export function resolveSlugCollision(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug;
  let suffix = 2;
  while (taken.has(`${slug}-${suffix}`)) {
    suffix += 1;
  }
  return `${slug}-${suffix}`;
}
