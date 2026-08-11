/**
 * `bun run setup` — das geführte First-Run-Setup (installer-plan.md). Läuft im
 * heutigen Source-Betrieb (git clone → bun install → setup) und ist der
 * wiederverwendbare Kern des künftigen Installers.
 *
 * Diese Datei ist die DÜNNE, interaktive Schale: sie sammelt echte Zustände und
 * Nutzereingaben und delegiert alle Logik an die reinen, getesteten Helfer in
 * scripts/lib/setup.ts. Sie wird bewusst NICHT im Test aufgerufen (prompt()/
 * confirm() würden hängen) — der ganze Ablauf steht deshalb hinter
 * `import.meta.main`.
 *
 * Ablauf exakt nach installer-plan.md „First-Run-Setup — Ablauf & Reihenfolge":
 *   Doctor → Anbieter-Wahl → Admin (Pflicht) → .env schreiben (chmod 600) →
 *   ~/macvibes-Baum → Baselines (msb) / Prozess-Fallback → Abschluss-Hinweis.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usernameSchema } from '@macvibes/shared';
import { druckeDoctorReport, erhebeDoctorInput } from './lib/doctorState';
import {
  begrenzeTreffer,
  filterModelle,
  holeModellListe,
  parseAuswahl,
  parseManuelleIds,
  trenneClaudeIds,
  type ModellKandidat,
} from './lib/modelCatalog';
import { erkenneAnbieterFormat, type FormatDiagnose } from './lib/providerProbe';
import { envVarName, litellmYamlMitEintrag, modelsJsonMitEintrag } from './lib/providerWiring';
import {
  buildEnvContent,
  doctor,
  envWertIstUnsicher,
  envZielPfad,
  sandboxModeFor,
  type AnbieterModell,
  type ProviderChoice,
  type SetupAnswers,
} from './lib/setup';

/** Eigene Anbieter (aus der Format-Probe) — brauchen models.json/litellm.yaml. */
type EigenerAnbieter = Extract<ProviderChoice, { kind: 'custom-anthropic' | 'custom-openai' }>;

/** Repo-Root modul-relativ (scripts/ liegt direkt darunter) — cwd-unabhängig. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Kann das Dateisystem unter `dir` POSIX-Modes durchsetzen? Feature-Detection
 * wie apps/server/src/core/fsCapabilities.ts (supportsPosixModes), hier BEWUSST
 * dupliziert statt importiert: Skripte importieren keinen Server-Code aus
 * apps/server/src/** (M6-Env-Gate, Composition-Root-Sauberkeit). Unter NTFS
 * meldet stat trotz chmod 0o666 → false, dann ist chmod 600 wirkungslos.
 */
function unterstuetztPosixModes(dir: string): boolean {
  const probe = join(dir, `.macvibes-mode-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, '');
    chmodSync(probe, 0o600);
    return (statSync(probe).mode & 0o077) === 0;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}

/**
 * Bestimmte Zeichen lassen sich nicht sicher in die single-quoted .env schreiben
 * und werden deshalb schon am Prompt abgewiesen (statt später beim Schreiben mit
 * einer Exception zu scheitern). Es sind GENAU die Zeichen aus envQuote/
 * ENV_UNSICHER — WARUM abgelehnt statt escaped (Bun-Quirks, empirisch verifiziert):
 *   - `$`  : Bun expandiert `$VAR` AUCH in Single-Quotes → stiller Wert-Ersatz;
 *            `\$`-Escaping ist unzuverlässig.
 *   - `\`  : ein auf `\` endender Wert frisst die schließende `'` und die
 *            Folgezeile (löscht das nächste Secret); `\\` wird nicht entschärft.
 *   - `'`  : terminiert den Wert; Bun kann es nicht escapen.
 *   - Steuerzeichen: zerreißen die Zeile.
 * Der Wert wird in der Meldung NIE genannt (Secret-Schutz) — nur die verbotenen
 * Zeichen. Einzige Ausnahme im Setup: der Admin-Username, den usernameSchema
 * (@macvibes/shared) ohnehin auf [a-z0-9_-] beschränkt — dort ist keines dieser
 * Zeichen möglich, deshalb bleibt leseAdminUsername unverändert.
 */
const VERBOTENE_ZEICHEN_HINWEIS =
  "  Nicht erlaubt: ' (Anführungszeichen), \\ (Backslash), $ (Dollar) und Steuerzeichen — bitte ohne diese Zeichen.";

/** Nicht-leere Eingabe erzwingen (z. B. Admin-Username — Pflicht). */
function pflichtEingabe(frage: string): string {
  for (;;) {
    const wert = (prompt(frage) ?? '').trim();
    if (wert === '') {
      console.log('  Eingabe erforderlich — bitte einen Wert angeben.');
      continue;
    }
    if (envWertIstUnsicher(wert)) {
      console.log(VERBOTENE_ZEICHEN_HINWEIS);
      continue;
    }
    return wert;
  }
}

/**
 * Admin-Username lesen und gegen `usernameSchema` (@macvibes/shared) prüfen —
 * dieselbe Regel, die die spätere Registrierung erzwingt. Das ist Teil der
 * Aussperr-Absicherung: ein hier akzeptierter Name, den das Schema später
 * ablehnt (z. B. Großbuchstaben), stünde in der .env, ließe sich aber nie
 * registrieren — dann würde der Bootstrap-Admin nie beansprucht und NIEMAND
 * würde Admin. Lieber am Prompt abweisen als im toten Zustand landen.
 */
function leseAdminUsername(frage: string): string {
  for (;;) {
    const wert = pflichtEingabe(frage);
    const ergebnis = usernameSchema.safeParse(wert);
    if (ergebnis.success) return wert;
    console.log(`  ${ergebnis.error.issues[0]?.message ?? 'Ungültiger Benutzername.'}`);
  }
}

/** Secret lesen, ohne es je zurückzudrucken (nur ob es gesetzt wurde). */
function leseSecret(frage: string): string {
  for (;;) {
    const wert = (prompt(frage) ?? '').trim();
    if (envWertIstUnsicher(wert)) {
      // Den Wert bewusst NICHT ausgeben — nur die verbotenen Zeichen nennen.
      console.log(VERBOTENE_ZEICHEN_HINWEIS);
      continue;
    }
    console.log(wert === '' ? '  (leer gelassen)' : '  ✓ übernommen (nicht angezeigt).');
    return wert;
  }
}

/** Basis-URL lesen — nur http(s)-URLs, sonst kann die Probe nichts anfangen. */
function leseBasisUrl(): string {
  for (;;) {
    const url = pflichtEingabe('    Basis-URL (z. B. https://openrouter.ai/api/v1): ');
    if (!/^https?:\/\//.test(url)) {
      console.log('    ⚠ Bitte eine vollständige http(s)://-URL angeben.');
      continue;
    }
    // Unverschlüsseltes http zu einem ENTFERNTEN Host: der Token ginge im
    // Klartext übers Netz. Lokale Shims (localhost) sind der legitime
    // Normalfall und bleiben unkommentiert.
    if (
      url.startsWith('http://') &&
      !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)
    ) {
      console.log(
        '    ⚠ Unverschlüsseltes http:// zu einem entfernten Host — der Token ginge im Klartext übers Netz.',
      );
      if (!confirm('    Trotzdem verwenden?')) continue;
    }
    return url;
  }
}

/**
 * Verbotene claude-ids aussortieren und melden — das Präfix ist reserviert:
 * der Credential-Proxy routet solche ids IMMER an die Anthropic-API, ein
 * eigener Anbieter käme nie an den Request (agentModel.ts lehnt solche
 * Einträge beim Laden ohnehin ab). Zentral, damit Listen-Auswahl UND
 * manueller Fallback dieselbe Regel mit derselben Meldung anwenden.
 */
function ohneClaudeIds(ids: string[]): string[] {
  const { erlaubt, verboten } = trenneClaudeIds(ids);
  if (verboten.length > 0) {
    console.log(
      `    ⚠ Übersprungen ("claude"-Präfix ist reserviert — der Proxy routet solche ids an die Anthropic-API): ${verboten.join(', ')}`,
    );
  }
  return erlaubt;
}

/**
 * Modelle aus der geholten Anbieter-Liste auswählen — suchen statt scrollen:
 * die Liste kann hunderte Einträge haben (OpenRouter), deshalb wird sie NIE
 * komplett gezeigt. Bedienung: Suchbegriff → gedeckelte, nummerierte Treffer →
 * Auswahl per Nummern (`1,3,7`) oder `alle`; beliebig viele Suchdurchgänge,
 * bis der Nutzer mit leerem Suchbegriff abschließt. Kleiner Katalog: einfach
 * Enter (leerer Begriff = alle zeigen), dann `alle`.
 */
function modelleAuswaehlen(katalog: ModellKandidat[], anbieterName: string): AnbieterModell[] {
  console.log(
    `    ✓ ${katalog.length} Modelle gefunden. Auswahl per Suche: Begriff eingeben,\n` +
      '    Treffer per Nummern (z. B. 1,3,7) oder "alle" übernehmen — mehrere Suchdurchgänge möglich.',
  );
  const gewaehlt = new Map<string, AnbieterModell>();
  for (;;) {
    const frage =
      gewaehlt.size === 0
        ? '    Suchbegriff (leer = alle anzeigen): '
        : `    Weiterer Suchbegriff (leer = fertig mit ${gewaehlt.size} Modell(en)): `;
    const begriff = (prompt(frage) ?? '').trim();
    if (begriff === '' && gewaehlt.size > 0) break;
    const treffer = filterModelle(katalog, begriff);
    if (treffer.length === 0) {
      console.log('    Kein Treffer — anderen Begriff versuchen.');
      continue;
    }
    const { angezeigt, restAnzahl } = begrenzeTreffer(treffer);
    console.log(`    ${treffer.length} Treffer:`);
    angezeigt.forEach((m, i) => {
      const schonGewaehlt = gewaehlt.has(m.id) ? ' ✓' : '';
      const labelZusatz = m.label === m.id ? '' : ` — ${m.label}`;
      console.log(`      ${String(i + 1).padStart(3)}) ${m.id}${labelZusatz}${schonGewaehlt}`);
    });
    if (restAnzahl > 0) {
      console.log(
        `      … und ${restAnzahl} weitere (nicht angezeigt) — Suchbegriff verfeinern oder "alle" nehmen.`,
      );
    }
    for (;;) {
      const eingabe =
        prompt(
          `    Übernehmen: Nummern (z. B. 1,3,7) · "alle" = alle ${treffer.length} Treffer · leer = nichts aus dieser Suche: `,
        ) ?? '';
      const auswahl = parseAuswahl(eingabe, angezeigt.length);
      if (auswahl.art === 'ungueltig') {
        console.log(`    ${auswahl.meldung}`);
        continue;
      }
      const neue =
        auswahl.art === 'alle'
          ? treffer
          : auswahl.art === 'nummern'
            ? auswahl.indizes.map((i) => angezeigt[i]).filter((m) => m !== undefined)
            : [];
      const erlaubteIds = new Set(ohneClaudeIds(neue.map((m) => m.id)));
      for (const modell of neue) {
        if (!erlaubteIds.has(modell.id)) continue;
        // Label fürs Dropdown: Anbieter-Label (name/display_name/id) + Anbietername.
        gewaehlt.set(modell.id, { id: modell.id, label: `${modell.label} (${anbieterName})` });
      }
      break;
    }
    console.log(`    → Bisher gewählt: ${gewaehlt.size} Modell(e).`);
  }
  return [...gewaehlt.values()];
}

/**
 * Manueller Fallback, wenn die Modell-Liste nicht abrufbar ist (404, Auth,
 * Netz): kommagetrennte Modell-IDs. Leer = überspringen (kein Zwang).
 */
function modelleManuellErfassen(anbieterName: string): AnbieterModell[] {
  for (;;) {
    const eingabe =
      prompt(
        '    Modell-IDs, kommagetrennt (z. B. qwen/qwen3-coder, glm-4.7; leer = überspringen): ',
      ) ?? '';
    const ids = parseManuelleIds(eingabe);
    if (ids.length === 0) return [];
    const erlaubt = ohneClaudeIds(ids);
    if (erlaubt.length === 0) continue;
    return erlaubt.map((id) => ({ id, label: `${id} (${anbieterName})` }));
  }
}

/**
 * EIN geführter Weg für eigene Anbieter: Anzeigename → URL → Token, dann die
 * MODELL-LISTE des Anbieters holen (GET /models; das Modell wird pro Chat im
 * Dropdown gewählt — deshalb eine Liste statt einer festgenagelten Modell-ID)
 * und daraus auswählen (Fallback: manuelle Eingabe). Danach entscheidet die
 * Format-PROBE (lib/providerProbe) mit dem ERSTEN gewählten Modell, ob der
 * Endpunkt Anthropic- oder OpenAI-Format spricht — EINE Probe genügt, das
 * Format hängt am Endpunkt, nicht am Modell. Bei Misserfolg: erneut versuchen
 * oder überspringen — NIE halb konfigurieren (null = nichts eingetragen).
 */
async function eigenenAnbieterErfassen(
  bisherige: ProviderChoice[],
): Promise<ProviderChoice | null> {
  console.log(
    '    Bekannte Basis-URLs als Anhalt: OpenRouter https://openrouter.ai/api/v1 ·\n' +
      '    OpenAI https://api.openai.com/v1 · eigener Shim z. B. http://localhost:8080\n' +
      '    Ob der Anbieter Anthropic- oder OpenAI-Format spricht, erkennt die Probe selbst.',
  );
  for (;;) {
    const name = pflichtEingabe('    Anzeigename des Anbieters (z. B. OpenRouter): ');
    const url = leseBasisUrl();
    const token = leseSecret('    Token/API-Key (leer, falls keiner nötig): ');

    console.log('    → Hole die Modell-Liste des Anbieters (GET /models) …');
    const katalog = await holeModellListe(url, token);
    let modelle: AnbieterModell[];
    if (katalog.length === 0) {
      console.log(
        '    ⚠ Modell-Liste nicht abrufbar (kein /models-Endpunkt, Auth oder Netz) — bitte manuell angeben.',
      );
      modelle = modelleManuellErfassen(name);
    } else {
      modelle = modelleAuswaehlen(katalog, name);
    }
    if (modelle.length === 0) {
      console.log('    Kein Modell gewählt.');
      if (nochmal()) continue;
      console.log('    → Übersprungen — es wurde nichts konfiguriert.');
      return null;
    }

    // Format-Probe mit dem ERSTEN gewählten Modell — das Format hängt am
    // Endpunkt, nicht am Modell; eine Probe genügt für den ganzen Anbieter.
    const erstesModell = modelle[0]?.id ?? '';
    console.log(
      `    → Prüfe den Endpunkt mit "${erstesModell}" (je eine Mini-Anfrage pro Format, max_tokens: 1) …`,
    );
    let diagnose: FormatDiagnose;
    try {
      diagnose = await erkenneAnbieterFormat(url, token, erstesModell);
    } catch (error) {
      // Darf praktisch nicht passieren (die Probe fängt Netzfehler selbst) —
      // aber nie verschlucken und nie halb konfigurieren.
      console.log(`    ✗ Probe fehlgeschlagen: ${error}`);
      if (nochmal()) continue;
      return null;
    }
    console.log(
      `    ${diagnose.art === 'anthropic' || diagnose.art === 'openai' ? '✓' : '✗'} ${diagnose.meldung}`,
    );

    if (diagnose.art === 'anthropic') {
      return token === ''
        ? { kind: 'custom-anthropic', name, modelle, url }
        : { kind: 'custom-anthropic', name, modelle, url, token };
    }
    if (diagnose.art === 'openai') {
      return baueOpenaiAnbieter(bisherige, { name, modelle, apiBase: diagnose.apiBase, token });
    }
    if (diagnose.art === 'modell-strittig') {
      // Format steht fest, nur das Modell ist strittig — Übernahme erlaubt,
      // aber bewusst (vielleicht mag der Anbieter nur den Minimal-Body nicht).
      const wahl = (
        prompt('    [u]ebernehmen trotzdem / [e]rneut eingeben / [s = überspringen]? ') ?? ''
      )
        .trim()
        .toLowerCase();
      if (wahl === 'u' || wahl === 'uebernehmen' || wahl === 'übernehmen') {
        if (diagnose.format === 'anthropic') {
          return token === ''
            ? { kind: 'custom-anthropic', name, modelle, url }
            : { kind: 'custom-anthropic', name, modelle, url, token };
        }
        return baueOpenaiAnbieter(bisherige, {
          name,
          modelle,
          apiBase: diagnose.apiBase ?? url,
          token,
        });
      }
      if (wahl === 'e' || wahl === 'erneut') continue;
      console.log('    → Übersprungen — es wurde nichts konfiguriert.');
      return null;
    }
    // token-abgelehnt / nicht-erreichbar / kein-format → nie halb konfigurieren.
    if (nochmal()) continue;
    console.log('    → Übersprungen — es wurde nichts konfiguriert.');
    return null;
  }
}

/** „[e]rneut versuchen / [s] überspringen?" — true = noch eine Runde. */
function nochmal(): boolean {
  const wahl = (prompt('    [e]rneut versuchen / [s = überspringen]? ') ?? '').trim().toLowerCase();
  return wahl === 'e' || wahl === 'erneut';
}

/**
 * OpenAI-kompatiblen Anbieter fertig bauen: Env-Namen aus dem Anzeigenamen
 * ableiten (Kollisionen mit schon gewählten Anbietern vermeiden). Ohne Token
 * bekommt die Env einen Platzhalter — LiteLLM verlangt einen api_key-Wert,
 * der Endpunkt ignoriert ihn dann einfach.
 */
function baueOpenaiAnbieter(
  bisherige: ProviderChoice[],
  daten: { name: string; modelle: AnbieterModell[]; apiBase: string; token: string },
): ProviderChoice {
  const vergeben = new Set<string>();
  for (const p of bisherige) if (p.kind === 'custom-openai') vergeben.add(p.envVar);
  const envVar = envVarName(daten.name, vergeben);
  const token = daten.token === '' ? 'unbenutzt' : daten.token;
  if (daten.token === '') {
    console.log(`    (kein Token angegeben — ${envVar} bekommt den Platzhalter 'unbenutzt'.)`);
  }
  console.log(
    `    ✓ ${daten.name}: ${daten.modelle.length} Modell(e) gewählt, Key landet als ${envVar} in der .env.`,
  );
  return {
    kind: 'custom-openai',
    name: daten.name,
    modelle: daten.modelle,
    apiBase: daten.apiBase,
    envVar,
    token,
  };
}

/**
 * Anbieter-Wahl. Claude ist Default; zusätzliche Anbieter sind optional und
 * kombinierbar — statt der früheren Format-Kunde (openrouter/openai/custom)
 * gibt es EINEN Weg „eigenen Anbieter hinzufügen", die Format-Probe entscheidet.
 * „Nur lokal, kein Claude" ist erlaubt (Warnung, kein Abbruch).
 */
async function anbieterWaehlen(): Promise<ProviderChoice[]> {
  const providers: ProviderChoice[] = [];

  if (confirm('Claude (Anthropic) als Modell-Anbieter nutzen? (empfohlen)')) {
    const oauth = confirm(
      '  Abo-Token via `claude setup-token` verwenden? (empfohlen; sonst API-Key)',
    );
    if (oauth) {
      const token = leseSecret('  CLAUDE_CODE_OAUTH_TOKEN (aus `claude setup-token`): ');
      if (token !== '') providers.push({ kind: 'claude-oauth', token });
    } else {
      const apiKey = leseSecret('  ANTHROPIC_API_KEY (Anthropic Console): ');
      if (apiKey !== '') providers.push({ kind: 'claude-apikey', apiKey });
    }
  }

  if (
    confirm(
      'Weitere KI-Anbieter hinzufügen? (Ollama lokal / eigener Anbieter per URL + Token, z. B. OpenRouter, OpenAI)',
    )
  ) {
    for (;;) {
      const wahl = (prompt('  Was hinzufügen? [ollama | anbieter] (leer = fertig): ') ?? '')
        .trim()
        .toLowerCase();
      if (wahl === '') break;
      if (wahl === 'ollama') {
        providers.push({ kind: 'ollama' });
        console.log('  ✓ Ollama (lokal) — der mitgelieferte LiteLLM-Router startet automatisch.');
      } else if (wahl === 'anbieter') {
        const neu = await eigenenAnbieterErfassen(providers);
        if (neu !== null) providers.push(neu);
      } else {
        console.log('  Unbekannte Wahl — bitte ollama oder anbieter.');
      }
    }
  }

  return providers;
}

async function main(): Promise<void> {
  console.log('macvibes — geführtes First-Run-Setup\n');

  // 1) Doctor — Zustands-Erhebung geteilt mit `macvibes doctor`
  // (lib/doctorState), reine Auswertung in lib/setup.
  const doctorInput = await erhebeDoctorInput();
  const msbAvailable = doctorInput.msbAvailable;
  const report = doctor(doctorInput);
  druckeDoctorReport(report);

  if (report.hatFehler) {
    console.error(
      '✗ Es fehlen zwingende Voraussetzungen (siehe ✗ oben). Bitte beheben und erneut: bun run setup',
    );
    process.exit(1);
  }
  if (report.hatWarnung && !confirm('Es gibt Warnungen (⚠). Trotzdem fortfahren?')) {
    console.log('Abgebrochen. Nach dem Beheben erneut: bun run setup');
    process.exit(0);
  }

  // 2) Anbieter-Wahl.
  const providers = await anbieterWaehlen();
  if (providers.length === 0) {
    console.log(
      '\n⚠ Kein Anbieter gewählt — Fallback auf lokale Modelle (Ollama). Ohne laufendes Ollama/Modell antwortet der Agent nicht.',
    );
    providers.push({ kind: 'ollama' });
  }
  if (!providers.some((p) => p.kind === 'claude-oauth' || p.kind === 'claude-apikey')) {
    console.log(
      '⚠ Kein Claude konfiguriert — nur lokale/zusätzliche Modelle stehen zur Verfügung.',
    );
  }

  // 3) Admin-Username — PFLICHT (Aussperr-Absicherung, H3). Leer nicht akzeptiert.
  console.log('');
  const adminUsername = leseAdminUsername(
    'Bootstrap-Admin-Username (wird beim Start zum Admin befördert; PFLICHT): ',
  );

  // 3b) Bootstrap-Token automatisch erzeugen (CSPRNG, hex — enthält damit nie
  // ein envQuote-verbotenes Zeichen): schützt den Admin-Namen vor Fremd-
  // Registrierung. Ohne den Token könnte auf einer frischen Instanz jeder im
  // LAN, der sich zuerst mit dem Namen registriert, Admin werden — der Server
  // lauscht auf 0.0.0.0. Der Nutzer muss sich den Wert NICHT merken: er steht
  // in der .env (Abschluss-Hinweis unten sagt, wo).
  const adminBootstrapToken = randomBytes(32).toString('hex');

  // 4) Sandbox-Modus aus der msb-Verfügbarkeit ableiten und .env schreiben.
  const sandboxMode = sandboxModeFor(msbAvailable);
  const answers: SetupAnswers = { adminUsername, adminBootstrapToken, sandboxMode, providers };

  // Ziel-.env nach Betriebsart wählen: Dev-Checkout (mit .git) → der
  // Repo-Override apps/server/.env; installierte Fassung (kein .git, z. B.
  // Homebrew-libexec) → die upgrade-feste <macvibesHome>/.env. Sonst läge die
  // Konfig (inkl. Token) in libexec und wäre nach jedem `brew upgrade` weg.
  const macvibesHome = process.env['MACVIBES_HOME'] ?? join(homedir(), 'macvibes');
  const istDevCheckout = existsSync(join(REPO_ROOT, '.git'));
  const envPfad = envZielPfad({ istDevCheckout, repoRoot: REPO_ROOT, macvibesHome });

  let envGeschrieben = false;
  if (existsSync(envPfad)) {
    // Nicht-destruktiv: bestehendes .env NIE stillschweigend überschreiben.
    const wahl = (
      prompt(`\n${envPfad} existiert bereits. [u]eberschreiben / [b]ehalten / [a]bbrechen? `) ?? ''
    )
      .trim()
      .toLowerCase();
    if (wahl === 'a' || wahl === 'abbrechen') {
      console.log('Abgebrochen — nichts verändert.');
      process.exit(0);
    }
    if (wahl === 'u' || wahl === 'ueberschreiben' || wahl === 'überschreiben') {
      schreibeEnv(envPfad, answers);
      envGeschrieben = true;
    } else {
      // Nicht-destruktiv per Default: alles außer einem AUSDRÜCKLICHEN
      // „ueberschreiben" (auch ein Tippfehler oder leere Eingabe) behält die
      // bestehende Datei — sie wird nie stillschweigend überschrieben.
      console.log(`→ ${envPfad} unverändert behalten (Anbieter-/Admin-Eingaben verworfen).`);
    }
  } else {
    schreibeEnv(envPfad, answers);
    envGeschrieben = true;
  }

  // 5) ~/macvibes-Verzeichnisbaum anlegen (Home + data-Ordner für die DB).
  mkdirSync(join(macvibesHome, 'data'), { recursive: true });
  console.log(`→ Verzeichnisbaum bereit: ${macvibesHome} (inkl. data/)`);

  // 5b) Eigene Anbieter verdrahten: models.json (Chat-Dropdown) und — für
  // OpenAI-kompatible — litellm.yaml. NUR wenn auch die .env geschrieben wurde:
  // sonst stünden Modelle im Katalog, deren Route/Key fehlt (halb konfiguriert).
  const eigene = providers.filter(
    (p): p is EigenerAnbieter => p.kind === 'custom-anthropic' || p.kind === 'custom-openai',
  );
  if (eigene.length > 0) {
    if (envGeschrieben) {
      verdrahteEigeneAnbieter(macvibesHome, eigene);
    } else {
      console.log(
        '→ Eigene Anbieter NICHT verdrahtet (die bestehende .env wurde behalten) — models.json/litellm.yaml unverändert.',
      );
    }
  }

  // 6) Baselines bauen (braucht laufendes msb) — sonst klar benannter Fallback.
  if (msbAvailable) {
    console.log('\n→ Baue Template-Baselines (bun run baselines) — kann beim ersten Mal dauern …');
    const proc = Bun.spawn(['bun', 'run', 'baselines'], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: process.env as Record<string, string>,
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(
        '⚠ Baseline-Bau fehlgeschlagen. Der Server läuft trotzdem (ohne Baselines bootet aber keine Projekt-VM).',
      );
      console.error('  Später erneut versuchen:  bun run baselines');
    }
  } else {
    console.log(
      `\n→ Kein msb — Prozess-Modus als Fallback gesetzt (MACVIBES_SANDBOX=${sandboxMode}, ohne VM-Isolat, nur Dev).`,
    );
    console.log(
      '  Voller VM-Modus später:  brew install superradcompany/tap/microsandbox && bun run baselines',
    );
  }

  // 7) Abschluss.
  console.log('\n✓ Setup abgeschlossen.');
  console.log('  Server starten:      bun run dev');
  console.log(
    `  Danach registrieren als „${adminUsername}" — dieser Nutzer wird automatisch Admin.`,
  );
  if (envGeschrieben) {
    // Der Token selbst wird bewusst NICHT auf die Konsole gedruckt (Secret);
    // der Nutzer erfährt, WO er steht und dass er ihn bei der Registrierung braucht.
    console.log('  WICHTIG: Bei dieser Erst-Registrierung das Feld „Bootstrap-Token" ausfüllen —');
    console.log(`  der Wert steht als MACVIBES_ADMIN_BOOTSTRAP_TOKEN in ${envPfad}.`);
    console.log('  Er schützt den Admin-Namen davor, dass ihn jemand anderes im Netz beansprucht.');
  }
}

/**
 * Eigene Anbieter in die Nutzer-Dateien unter `<macvibesHome>` eintragen —
 * pro Anbieter für JEDES ausgewählte Modell:
 *   - `models.json`  — je Modell ein Dropdown-Eintrag (alle eigenen Anbieter);
 *     `slow: true`, weil Latenz fremder Endpunkte unbekannt ist — lieber
 *     großzügige Timeouts als abgebrochene Turns (agentTimeoutsFor behandelt
 *     Unbekanntes ohnehin so).
 *   - `litellm.yaml` — je Modell ein Router-Alias (nur OpenAI-kompatible).
 *     Existiert die Datei noch nicht, startet sie als Kopie der MITGELIEFERTEN
 *     litellm_config.yaml: so behält der Nutzer die Ollama-Basis-Einträge und
 *     den `'*'`-Catch-all (muss auch nach n Einfügungen letzter Eintrag
 *     bleiben — providerWiring fügt jeweils davor ein). Eine vorhandene Datei
 *     wird ERGÄNZT, nie überschrieben; Duplikate werden nur gemeldet.
 * Beides 0600 (defensiv; Secrets selbst stehen nur in der .env).
 */
function verdrahteEigeneAnbieter(macvibesHome: string, eigene: EigenerAnbieter[]): void {
  const modelsPfad = join(macvibesHome, 'models.json');
  let modelsRaw: string | null = existsSync(modelsPfad) ? readFileSync(modelsPfad, 'utf8') : null;
  let modelsGeaendert = false;
  for (const anbieter of eigene) {
    for (const modell of anbieter.modelle) {
      const ergebnis = modelsJsonMitEintrag(modelsRaw, {
        id: modell.id,
        label: modell.label,
        slow: true,
      });
      if (ergebnis.hinweis !== undefined) console.log(`  ⚠ ${ergebnis.hinweis}`);
      if (ergebnis.geaendert) {
        modelsRaw = ergebnis.inhalt;
        modelsGeaendert = true;
      }
    }
  }
  if (modelsGeaendert && modelsRaw !== null) {
    writeFileSync(modelsPfad, modelsRaw, { mode: 0o600 });
    // mode greift nur bei Neuanlage — bestehende Datei explizit nachziehen.
    chmodSync(modelsPfad, 0o600);
    console.log(`→ ${modelsPfad} ergänzt — die Modelle erscheinen im Chat-Dropdown.`);
  }

  const openaiAnbieter = eigene.filter(
    (p): p is Extract<EigenerAnbieter, { kind: 'custom-openai' }> => p.kind === 'custom-openai',
  );
  if (openaiAnbieter.length === 0) return;
  const litellmPfad = join(macvibesHome, 'litellm.yaml');
  const hatteDatei = existsSync(litellmPfad);
  let yamlRaw = hatteDatei
    ? readFileSync(litellmPfad, 'utf8')
    : readFileSync(
        join(REPO_ROOT, 'apps', 'server', 'local-router', 'litellm_config.yaml'),
        'utf8',
      );
  // Eine frisch aus der Basis erzeugte Datei muss auch dann geschrieben werden,
  // wenn ein Eintrag als Duplikat übersprungen wird.
  let yamlGeaendert = !hatteDatei;
  for (const anbieter of openaiAnbieter) {
    for (const modell of anbieter.modelle) {
      const ergebnis = litellmYamlMitEintrag(yamlRaw, {
        modelName: modell.id,
        litellmModel: `openai/${modell.id}`,
        apiBase: anbieter.apiBase,
        apiKeyEnv: anbieter.envVar,
        kommentar: anbieter.name,
      });
      if (ergebnis.hinweis !== undefined) console.log(`  ⚠ ${ergebnis.hinweis}`);
      if (ergebnis.geaendert) {
        yamlRaw = ergebnis.inhalt;
        yamlGeaendert = true;
      }
    }
  }
  if (yamlGeaendert) {
    writeFileSync(litellmPfad, yamlRaw, { mode: 0o600 });
    // mode greift nur bei Neuanlage — bestehende Datei explizit nachziehen.
    chmodSync(litellmPfad, 0o600);
    console.log(
      `→ ${litellmPfad} geschrieben — der Router nutzt ab jetzt DIESE Datei (Basis-Einträge + Catch-all bleiben erhalten).`,
    );
  }
}

/** .env schreiben und (falls möglich) auf 0600 sperren — nie den Inhalt loggen. */
function schreibeEnv(envPfad: string, answers: SetupAnswers): void {
  // Zielverzeichnis sicherstellen: bei der installierten Fassung ist das
  // <macvibesHome>, das erst weiter unten (Schritt 5) voll angelegt wird.
  const ordner = dirname(envPfad);
  mkdirSync(ordner, { recursive: true });
  // TOCTOU-Vermeidung: den Mode DIREKT beim Erzeugen setzen, damit die Datei mit
  // ihren Secrets nie — auch nicht kurz — mit Default-Rechten (0644) existiert.
  // Das nachträgliche chmod bleibt als defensiver Zweitschritt (u. a. falls die
  // Datei schon existierte und writeFileSync den Mode dann nicht mehr anpasst).
  writeFileSync(envPfad, buildEnvContent(answers), { mode: 0o600 });
  if (unterstuetztPosixModes(ordner)) {
    chmodSync(envPfad, 0o600);
    console.log(`→ ${envPfad} geschrieben (chmod 600).`);
  } else {
    console.log(`→ ${envPfad} geschrieben (Datei enthält Secrets — Zugriff selbst einschränken).`);
  }
}

if (import.meta.main) {
  await main();
}
