/**
 * Verdrahtung eines erkannten Anbieters (`bun run setup`) — reine, testbare
 * Logik ohne Syscalls: Env-Variablennamen ableiten, `models.json` ergänzen,
 * `litellm.yaml` aus der mitgelieferten Basis + Nutzer-Einträgen erzeugen.
 * Die interaktive Schale (scripts/setup.ts) liest/schreibt die Dateien.
 *
 * Nicht-destruktiv per Bauart: beide Ergänzer geben bei jeder Unklarheit
 * (kaputte Datei, Duplikat) den ORIGINAL-Inhalt unverändert zurück und melden
 * einen Hinweis — eine Nutzerdatei wird nie stillschweigend zerstört.
 */

/**
 * Reservierte Env-Namen: `ANTHROPIC_API_KEY` ist der Claude-Key des
 * Credential-Proxys (config.ts) — ein Fremdanbieter darf ihn nicht kapern
 * (sonst gingen plötzlich alle claude-* Modelle mit dem Fremd-Token raus).
 * `CLAUDE_CODE_OAUTH_TOKEN` analog. `MACVIBES_`-Präfixe sind
 * Server-Konfiguration und ebenfalls tabu (s. envVarName).
 */
export const RESERVIERTE_ENV_NAMEN: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

/**
 * Env-Variablenname für den Key eines Anbieters, abgeleitet aus dem
 * Anzeigenamen: GROSS, alles außer [A-Z0-9] wird zu `_` zusammengefasst,
 * Suffix `_API_KEY`. Beispiele: „OpenRouter" → OPENROUTER_API_KEY (bewusste
 * Konvergenz mit den Beispielen der mitgelieferten litellm_config.yaml),
 * „Mistral AI" → MISTRAL_AI_API_KEY. Kollisionen (schon vergebene oder
 * reservierte Namen) bekommen einen nummerierten Suffix (_2, _3, …) statt
 * still zu überschreiben; ein `MACVIBES_`-Präfix würde wie Server-Konfig
 * aussehen und wird mit `ANBIETER_` entschärft.
 */
export function envVarName(anzeigeName: string, vergeben: ReadonlySet<string>): string {
  let kern = anzeigeName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (kern === '') kern = 'ANBIETER';
  // Env-Namen dürfen nicht mit einer Ziffer beginnen (POSIX) — entschärfen.
  if (/^[0-9]/.test(kern)) kern = `A_${kern}`;
  if (kern.startsWith('MACVIBES')) kern = `ANBIETER_${kern}`;
  const basis = `${kern}_API_KEY`;
  if (!vergeben.has(basis) && !RESERVIERTE_ENV_NAMEN.has(basis)) return basis;
  for (let n = 2; ; n++) {
    const kandidat = `${basis}_${n}`;
    if (!vergeben.has(kandidat) && !RESERVIERTE_ENV_NAMEN.has(kandidat)) return kandidat;
  }
}

/** Ergebnis einer nicht-destruktiven Datei-Ergänzung. */
export interface ErgaenzungsErgebnis {
  inhalt: string;
  geaendert: boolean;
  /** Warum nichts (oder nur mit Vorbehalt) geändert wurde — fürs Setup-Log. */
  hinweis?: string;
}

export interface ModellEintrag {
  id: string;
  label: string;
  slow: boolean;
}

/**
 * `<macvibesHome>/models.json` um ein Modell ergänzen (fürs Chat-Dropdown,
 * s. agentModel.ts/loadUserAgentModels). null = Datei existiert noch nicht.
 * Bestehende Einträge bleiben byte-genau erhalten (parse + append, kein
 * Umformatieren fremder Felder); Duplikate und kaputte Dateien werden nur
 * gemeldet, nie „repariert".
 */
export function modelsJsonMitEintrag(
  bestehendRaw: string | null,
  eintrag: ModellEintrag,
): ErgaenzungsErgebnis {
  if (bestehendRaw === null) {
    return { inhalt: `${JSON.stringify([eintrag], null, 2)}\n`, geaendert: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bestehendRaw);
  } catch {
    return {
      inhalt: bestehendRaw,
      geaendert: false,
      hinweis: `models.json ist kein gültiges JSON — nicht angefasst. Bitte manuell ergänzen: ${JSON.stringify(eintrag)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      inhalt: bestehendRaw,
      geaendert: false,
      hinweis: `models.json ist kein JSON-Array — nicht angefasst. Bitte manuell ergänzen: ${JSON.stringify(eintrag)}`,
    };
  }
  const schonDa = parsed.some(
    (e) => typeof e === 'object' && e !== null && (e as { id?: unknown }).id === eintrag.id,
  );
  if (schonDa) {
    return {
      inhalt: bestehendRaw,
      geaendert: false,
      hinweis: `models.json führt "${eintrag.id}" bereits — Eintrag unverändert gelassen.`,
    };
  }
  return { inhalt: `${JSON.stringify([...parsed, eintrag], null, 2)}\n`, geaendert: true };
}

export interface LitellmEintrag {
  /** model_name — exakt die id aus models.json (Katalog ↔ Router-Alias). */
  modelName: string;
  /** litellm_params.model, z. B. `openai/<id>`. */
  litellmModel: string;
  /** litellm_params.api_base — die Basis, auf die die Probe ansprang. */
  apiBase: string;
  /** Name der Env-Variable mit dem Key (litellm liest `os.environ/<NAME>`). */
  apiKeyEnv: string;
  /** Anzeigename des Anbieters für den erzeugten Kommentar. */
  kommentar: string;
}

/** YAML-Single-Quoting: `'` wird per Verdopplung escaped (YAML-Spezifikation). */
function yamlQuote(wert: string): string {
  return `'${wert.replaceAll("'", "''")}'`;
}

/** Zeile, an der der Catch-all-Eintrag beginnt (Claude Codes Hilfsmodelle). */
const CATCHALL_ZEILE = /^\s*-\s*model_name:\s*'\*'/m;

/**
 * Die Router-Config um einen OpenAI-kompatiblen Anbieter ergänzen. Basis ist
 * die MITGELIEFERTE litellm_config.yaml (bzw. eine schon vorhandene
 * `<macvibesHome>/litellm.yaml`): so behält der Nutzer die Ollama-Basis-Einträge
 * und den `'*'`-Catch-all — ohne ihn brechen Claude Codes Hilfsmodell-Aufrufe
 * (der Router antwortete mit 400) und beim Umschalten fehlten die lokalen
 * Modelle. Der neue Eintrag wird deshalb VOR dem Catch-all eingefügt (LiteLLM
 * matcht der Reihe nach; der Catch-all muss letzter Eintrag bleiben). Fehlt der
 * Catch-all (handgeschriebene Nutzerdatei), wird vor `litellm_settings:` bzw.
 * ans Ende eingefügt und der fehlende Catch-all als Hinweis gemeldet.
 */
export function litellmYamlMitEintrag(
  basisRaw: string,
  eintrag: LitellmEintrag,
): ErgaenzungsErgebnis {
  const nameZeile = new RegExp(
    `^\\s*-\\s*model_name:\\s*(?:${escapeRegExp(yamlQuote(eintrag.modelName))}|${escapeRegExp(eintrag.modelName)})\\s*$`,
    'm',
  );
  if (nameZeile.test(basisRaw)) {
    return {
      inhalt: basisRaw,
      geaendert: false,
      hinweis: `litellm.yaml führt "${eintrag.modelName}" bereits — Eintrag unverändert gelassen.`,
    };
  }

  const block =
    `  # --- ${eintrag.kommentar} (eingetragen von \`bun run setup\`) ---\n` +
    `  - model_name: ${yamlQuote(eintrag.modelName)}\n` +
    `    litellm_params:\n` +
    `      model: ${yamlQuote(eintrag.litellmModel)}\n` +
    `      api_base: ${yamlQuote(eintrag.apiBase)}\n` +
    `      api_key: os.environ/${eintrag.apiKeyEnv}\n`;

  const catchallTreffer = CATCHALL_ZEILE.exec(basisRaw);
  if (catchallTreffer !== null) {
    const position = catchallTreffer.index;
    return {
      inhalt: `${basisRaw.slice(0, position)}${block}\n${basisRaw.slice(position)}`,
      geaendert: true,
    };
  }

  const hinweisOhneCatchall =
    "Achtung: die Router-Config hat KEINEN '*'-Catch-all-Eintrag — Claude Codes " +
    'Hilfsmodell-Aufrufe (claude-*-haiku etc.) beantwortet der Router dann mit 400. ' +
    'Empfehlung: den Catch-all aus apps/server/local-router/litellm_config.yaml als LETZTEN Eintrag übernehmen.';
  const settingsTreffer = /^litellm_settings:/m.exec(basisRaw);
  if (settingsTreffer !== null) {
    const position = settingsTreffer.index;
    return {
      inhalt: `${basisRaw.slice(0, position)}${block}\n${basisRaw.slice(position)}`,
      geaendert: true,
      hinweis: hinweisOhneCatchall,
    };
  }
  const mitNewline = basisRaw.endsWith('\n') ? basisRaw : `${basisRaw}\n`;
  return { inhalt: `${mitNewline}${block}`, geaendert: true, hinweis: hinweisOhneCatchall };
}

/** Regex-Metazeichen eines Literals escapen (für die Duplikat-Erkennung). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
