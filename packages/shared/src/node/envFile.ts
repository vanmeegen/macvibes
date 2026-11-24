/**
 * Minimaler Parser für die macvibes-`.env`-Dateien — EINE Implementierung für
 * den Server (Home-Fallback `<macvibesHome>/.env`) und die Repo-Skripte
 * (Preflight, Doctor, Shutdown), damit beide dieselbe Datei gleich lesen.
 *
 * Bewusst OHNE `$`-Expansion — anders als Buns cwd-Autolader, der `$VAR` auch in
 * Single-Quotes expandiert (Quirk, dokumentiert in scripts/lib/setup.ts). Das
 * Setup schreibt hier ohnehin nur single-quotierte Werte ohne `$`/`\`/`'`
 * (envQuote lehnt die ab), deshalb ist literales Lesen korrekt und frei von
 * Überraschungs-Expansion. Umschließende einfache/doppelte Quotes werden
 * entfernt; Kommentar- und Leerzeilen ignoriert; ein vorangestelltes `export `
 * ist erlaubt. Spätere Zeilen gewinnen (wie dotenv).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1] as string] = value;
  }
  return out;
}
