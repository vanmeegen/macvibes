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
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usernameSchema } from '@macvibes/shared';
import { druckeDoctorReport, erhebeDoctorInput } from './lib/doctorState';
import {
  buildEnvContent,
  doctor,
  envWertIstUnsicher,
  envZielPfad,
  sandboxModeFor,
  type ProviderChoice,
  type SetupAnswers,
} from './lib/setup';

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

/**
 * Anbieter-Wahl. Claude ist Default; zusätzliche Systeme (LiteLLM) sind optional
 * und kombinierbar. „Nur lokal, kein Claude" ist erlaubt (Warnung, kein Abbruch).
 */
function anbieterWaehlen(): ProviderChoice[] {
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
      'Weitere KI-Systeme über LiteLLM hinzufügen? (Ollama lokal / OpenAI / OpenRouter / eigener Endpunkt)',
    )
  ) {
    for (;;) {
      const wahl = (
        prompt('  Backend? [ollama | openai | openrouter | custom] (leer = fertig): ') ?? ''
      )
        .trim()
        .toLowerCase();
      if (wahl === '') break;
      if (wahl === 'ollama') {
        providers.push({ kind: 'ollama' });
        console.log('  ✓ Ollama (lokal) — der mitgelieferte LiteLLM-Router startet automatisch.');
      } else if (wahl === 'openai' || wahl === 'openrouter' || wahl === 'custom') {
        const preset =
          wahl === 'openai'
            ? { prefix: 'gpt-', upstreamUrl: 'https://api.openai.com' }
            : wahl === 'openrouter'
              ? { prefix: 'or/', upstreamUrl: 'https://openrouter.ai/api' }
              : { prefix: '', upstreamUrl: '' };
        const prefix =
          (
            prompt(`    Modell-Prefix (matcht das \`model\` im Body) [${preset.prefix}]: `) ?? ''
          ).trim() || preset.prefix;
        const upstreamUrl =
          (
            prompt(
              `    Base-URL des Anthropic-/v1/messages-kompatiblen Endpunkts [${preset.upstreamUrl}]: `,
            ) ?? ''
          ).trim() || preset.upstreamUrl;
        if (envWertIstUnsicher(prefix) || envWertIstUnsicher(upstreamUrl)) {
          console.log(
            "    ⚠ Prefix und Base-URL dürfen kein ' \\ $ oder Steuerzeichen enthalten — Eintrag übersprungen.",
          );
          continue;
        }
        const apiKey = leseSecret('    API-Key (leer, falls keiner nötig): ');
        if (prefix === '' || upstreamUrl === '') {
          console.log('    ⚠ Prefix und Base-URL sind nötig — Eintrag übersprungen.');
        } else {
          providers.push(
            apiKey === ''
              ? { kind: 'route', prefix, upstreamUrl }
              : { kind: 'route', prefix, upstreamUrl, apiKey },
          );
          console.log(`    ✓ Route ${prefix} → ${upstreamUrl}`);
        }
      } else {
        console.log('  Unbekannte Wahl — bitte ollama, openai, openrouter oder custom.');
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
  const providers = anbieterWaehlen();
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

  // 4) Sandbox-Modus aus der msb-Verfügbarkeit ableiten und .env schreiben.
  const sandboxMode = sandboxModeFor(msbAvailable);
  const answers: SetupAnswers = { adminUsername, sandboxMode, providers };

  // Ziel-.env nach Betriebsart wählen: Dev-Checkout (mit .git) → der
  // Repo-Override apps/server/.env; installierte Fassung (kein .git, z. B.
  // Homebrew-libexec) → die upgrade-feste <macvibesHome>/.env. Sonst läge die
  // Konfig (inkl. Token) in libexec und wäre nach jedem `brew upgrade` weg.
  const macvibesHome = process.env['MACVIBES_HOME'] ?? join(homedir(), 'macvibes');
  const istDevCheckout = existsSync(join(REPO_ROOT, '.git'));
  const envPfad = envZielPfad({ istDevCheckout, repoRoot: REPO_ROOT, macvibesHome });

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
    } else {
      // Nicht-destruktiv per Default: alles außer einem AUSDRÜCKLICHEN
      // „ueberschreiben" (auch ein Tippfehler oder leere Eingabe) behält die
      // bestehende Datei — sie wird nie stillschweigend überschrieben.
      console.log(`→ ${envPfad} unverändert behalten (Anbieter-/Admin-Eingaben verworfen).`);
    }
  } else {
    schreibeEnv(envPfad, answers);
  }

  // 5) ~/macvibes-Verzeichnisbaum anlegen (Home + data-Ordner für die DB).
  mkdirSync(join(macvibesHome, 'data'), { recursive: true });
  console.log(`→ Verzeichnisbaum bereit: ${macvibesHome} (inkl. data/)`);

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
