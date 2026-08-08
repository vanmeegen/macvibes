/**
 * Reine Helfer des First-Run-Setups (`bun run setup`). Getestet wird NUR die
 * Logik (Env-Erzeugung, Anbieter-Mapping, Doctor-Auswertung, Sandbox-Wahl) —
 * die interaktive Schale scripts/setup.ts wird hier bewusst NICHT aufgerufen
 * (sie würde an prompt()/confirm() hängen). Test-first nach CLAUDE.md.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { adminNameAusEnvDatei } from '../../preflight';
import {
  buildEnvContent,
  doctor,
  envQuote,
  mergeProviderEnv,
  providerEnv,
  sandboxModeFor,
  type DoctorInput,
  type ProviderChoice,
  type SetupAnswers,
} from '../setup';

/**
 * ECHTER Round-Trip gegen Buns .env-Parser (hier Bun 1.3.14) — kein Hand-Modell.
 *
 * WARUM Subprozess statt Hand-Parser: der frühere `parseEnvZeile`-Helfer bildete
 * nur Buns #-Inline-Kommentar-Regel nach und ignorierte, dass Bun `$VAR` AUCH in
 * Single-Quotes expandiert und ein `\` am Wortende die schließende `'` samt
 * Folgezeile frisst. Er erzeugte damit Falsch-Sicherheit. Diese Funktion schreibt
 * `buildEnvContent`-Ausgabe PLUS eine SENTINEL-Folgezeile in eine temporäre .env
 * und lässt einen `bun`-Subprozess (cwd = tempdir → Bun lädt die .env automatisch)
 * die interessierenden Keys als JSON ausgeben. So entscheidet der ECHTE Parser,
 * nicht unsere Vermutung. Deterministisch (spawnSync, kein Hängen), CI-tauglich
 * (bun ist da). Die getesteten Keys werden aus dem Kind-Env entfernt, damit ein
 * evtl. im Elternprozess gesetzter Wert die .env-Auswertung nicht überdeckt (Bun
 * überschreibt bereits vorhandene Umgebungsvariablen NICHT aus der .env).
 */
const RT_KEYS = [
  'MACVIBES_ADMIN_USERNAME',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'MACVIBES_MODEL_ROUTES',
  'SENTINEL',
] as const;

function roundTripViaBun(content: string): Record<string, string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'macvibes-env-rt-'));
  try {
    // SENTINEL-Folgezeile: bleibt sie intakt, hat die davorstehende gequotete
    // Secret-Zeile NICHT die nächste Zeile mitgefressen (Trailing-`\`-Zeilenfraß).
    writeFileSync(join(dir, '.env'), `${content}SENTINEL='intact'\n`);
    const reader =
      `const o={};for(const k of ${JSON.stringify(RT_KEYS)})o[k]=process.env[k]??null;` +
      'process.stdout.write(JSON.stringify(o));';
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
    for (const k of RT_KEYS) delete childEnv[k];
    const proc = Bun.spawnSync(['bun', '-e', reader], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv,
    });
    if (!proc.success) throw new Error(`Bun-Subprozess scheiterte: ${proc.stderr.toString()}`);
    return JSON.parse(proc.stdout.toString()) as Record<string, string | null>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('providerEnv — Anbieter-Wahl auf Env-Vars abbilden', () => {
  test('claude-oauth setzt CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(providerEnv({ kind: 'claude-oauth', token: 'sk-oauth-xyz' })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-oauth-xyz',
    });
  });

  test('claude-apikey setzt ANTHROPIC_API_KEY', () => {
    expect(providerEnv({ kind: 'claude-apikey', apiKey: 'sk-ant-123' })).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-123',
    });
  });

  test('ollama braucht keine Env — der mitgelieferte Router startet automatisch', () => {
    // detectLocalRouterCommand() in config.ts liefert per Default das gebündelte
    // run.ts → lokale Modelle sind ohne jede Env aktiv. Bewusst leere Map.
    expect(providerEnv({ kind: 'ollama' })).toEqual({});
  });

  test('route erzeugt einen MACVIBES_MODEL_ROUTES-Eintrag mit apiKey', () => {
    const env = providerEnv({
      kind: 'route',
      prefix: 'gpt-',
      upstreamUrl: 'https://api.openai.com',
      apiKey: 'sk-openai',
    });
    expect(JSON.parse(env['MACVIBES_MODEL_ROUTES'] ?? '[]')).toEqual([
      { prefix: 'gpt-', upstreamUrl: 'https://api.openai.com', apiKey: 'sk-openai' },
    ]);
  });

  test('route ohne apiKey lässt das Feld weg (nicht undefined serialisieren)', () => {
    const env = providerEnv({ kind: 'route', prefix: 'or/', upstreamUrl: 'https://x' });
    expect(JSON.parse(env['MACVIBES_MODEL_ROUTES'] ?? '[]')).toEqual([
      { prefix: 'or/', upstreamUrl: 'https://x' },
    ]);
  });
});

describe('mergeProviderEnv — kombinierbare Anbieter', () => {
  test('Claude + OpenRouter kombiniert: beide Env-Keys stehen nebeneinander', () => {
    const merged = mergeProviderEnv([
      { kind: 'claude-oauth', token: 'tok' },
      { kind: 'route', prefix: 'or/', upstreamUrl: 'https://openrouter.ai/api', apiKey: 'sk-or' },
    ]);
    expect(merged['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok');
    expect(JSON.parse(merged['MACVIBES_MODEL_ROUTES'] ?? '[]')).toEqual([
      { prefix: 'or/', upstreamUrl: 'https://openrouter.ai/api', apiKey: 'sk-or' },
    ]);
  });

  test('mehrere Routen fließen in EIN JSON-Array zusammen', () => {
    const merged = mergeProviderEnv([
      { kind: 'route', prefix: 'gpt-', upstreamUrl: 'https://api.openai.com', apiKey: 'a' },
      { kind: 'route', prefix: 'or/', upstreamUrl: 'https://openrouter.ai/api', apiKey: 'b' },
    ]);
    expect(JSON.parse(merged['MACVIBES_MODEL_ROUTES'] ?? '[]')).toHaveLength(2);
  });

  test('nur lokal (Ollama), kein Claude: keine Claude-Keys in der Map', () => {
    const merged = mergeProviderEnv([{ kind: 'ollama' }]);
    expect(merged['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(merged['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(merged['MACVIBES_MODEL_ROUTES']).toBeUndefined();
  });
});

describe('buildEnvContent — .env-Inhalt aus den Antworten', () => {
  const claudeAnswers: SetupAnswers = {
    adminUsername: 'marco',
    sandboxMode: 'microsandbox',
    providers: [{ kind: 'claude-oauth', token: 'sk-oauth-xyz' }],
  };

  test('schreibt Pflicht-Admin (single-quoted) und Sandbox-Modus', () => {
    const content = buildEnvContent(claudeAnswers);
    expect(content).toContain("MACVIBES_ADMIN_USERNAME='marco'");
    expect(content).toContain('MACVIBES_SANDBOX=microsandbox');
  });

  test('das erzeugte MACVIBES_ADMIN_USERNAME ist preflight-kompatibel', () => {
    // Regressionsschutz: der Preflight liest denselben Key aus derselben Datei.
    const dir = mkdtempSync(join(tmpdir(), 'macvibes-setup-'));
    try {
      const datei = join(dir, '.env');
      writeFileSync(datei, buildEnvContent(claudeAnswers));
      expect(adminNameAusEnvDatei(datei)).toBe('marco');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('nur gesetzte Keys landen im Inhalt (kein leerer ANTHROPIC_API_KEY)', () => {
    const content = buildEnvContent(claudeAnswers);
    expect(content).toContain("CLAUDE_CODE_OAUTH_TOKEN='sk-oauth-xyz'");
    expect(content).not.toContain('ANTHROPIC_API_KEY=');
  });

  test('Claude + OpenRouter: beide Keys stehen in der Datei', () => {
    const content = buildEnvContent({
      adminUsername: 'marco',
      sandboxMode: 'process',
      providers: [
        { kind: 'claude-apikey', apiKey: 'sk-ant' },
        { kind: 'route', prefix: 'or/', upstreamUrl: 'https://openrouter.ai/api', apiKey: 'sk-or' },
      ],
    });
    expect(content).toContain("ANTHROPIC_API_KEY='sk-ant'");
    expect(content).toContain("MACVIBES_MODEL_ROUTES='");
    expect(content).toContain('openrouter.ai');
  });

  test('nur lokal, kein Claude: klarer Hinweis statt stiller Leere', () => {
    const content = buildEnvContent({
      adminUsername: 'marco',
      sandboxMode: 'process',
      providers: [{ kind: 'ollama' }],
    });
    expect(content).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=');
    expect(content).not.toContain('ANTHROPIC_API_KEY=');
    expect(content.toLowerCase()).toContain('kein claude');
  });

  test('endet mit genau einem abschließenden Newline', () => {
    expect(buildEnvContent(claudeAnswers).endsWith('\n')).toBe(true);
    expect(buildEnvContent(claudeAnswers).endsWith('\n\n')).toBe(false);
  });
});

describe('buildEnvContent — echter Round-Trip gegen Buns .env-Parser (kein Hand-Modell)', () => {
  test('#-haltige Token/Route-apiKey/Admin kommen EXAKT zurück, SENTINEL-Folgezeile intakt', () => {
    // Ohne Quoting schneidet Bun jeden unquoted Wert am ersten `#` ab; plain
    // Single-Quotes machen ihn round-trip-fest, ohne die Folgezeile zu berühren.
    const env = roundTripViaBun(
      buildEnvContent({
        adminUsername: 'admin-01',
        sandboxMode: 'process',
        providers: [
          { kind: 'claude-oauth', token: 'oauth#tok#en' },
          { kind: 'route', prefix: 'gpt-', upstreamUrl: 'https://api.openai.com', apiKey: 'k#1' },
        ],
      }),
    );
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth#tok#en');
    expect(env['MACVIBES_ADMIN_USERNAME']).toBe('admin-01');
    expect(env['SENTINEL']).toBe('intact');
    // Das ganze MODEL_ROUTES-JSON (mit inneren `"` und `#` im apiKey) muss
    // literal durchkommen und wieder parsebar sein.
    expect(JSON.parse(env['MACVIBES_MODEL_ROUTES'] ?? 'null')).toEqual([
      { prefix: 'gpt-', upstreamUrl: 'https://api.openai.com', apiKey: 'k#1' },
    ]);
  });

  test('ANTHROPIC_API_KEY mit # bleibt vollständig und die Folgezeile überlebt', () => {
    const env = roundTripViaBun(
      buildEnvContent({
        adminUsername: 'admin-01',
        sandboxMode: 'process',
        providers: [{ kind: 'claude-apikey', apiKey: 'sk-x#y' }],
      }),
    );
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-x#y');
    expect(env['SENTINEL']).toBe('intact');
  });
});

describe('envQuote — lehnt ab, was Single-Quotes nicht sicher transportieren', () => {
  // Belege (echtes Bun 1.3.14, s. roundTripViaBun/Setup-Bug): `$VAR` expandiert
  // AUCH in Single-Quotes (stiller Wert-Ersatz); ein Wert der auf `\` endet frisst
  // die schließende `'` samt Folgezeile; `'` terminiert den String vorzeitig.
  // Deshalb werden diese Zeichen abgelehnt statt (unzuverlässig) escaped.
  const boese: Array<[string, string]> = [
    ['Single-Quote', "sk-'-x"],
    ['Backslash', 'sk-\\-x'],
    ['Trailing-Backslash', 'sk-x\\'],
    ['Dollar', 'sk-$HOME'],
    ['Steuerzeichen-Newline', 'sk-\n-x'],
    ['Steuerzeichen-Tab', 'sk-\t-x'],
  ];
  for (const [name, wert] of boese) {
    test(`${name} wirft — mit label, NIE dem Wert (kein Secret-Leak)`, () => {
      let msg = '';
      try {
        envQuote(wert, 'MY_SECRET');
        throw new Error('sollte werfen, tat es aber nicht');
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain('MY_SECRET');
      expect(msg).not.toContain(wert);
    });
  }

  test('unbedenklicher Wert (#, ", :, /, {}, =, +, Leerzeichen) wird plain single-quoted', () => {
    // Beweis, dass NICHT übertrieben abgelehnt wird — genau diese Zeichen
    // round-trippen laut Spec sauber (JSON inklusive).
    expect(envQuote('a#b":/ {}=+', 'X')).toBe("'a#b\":/ {}=+'");
  });
});

describe('buildEnvContent — sperrt Werte aus, die Buns Parser korrumpieren würde', () => {
  test('Secret mit $ wirft (würde in Single-Quotes still expandiert/injiziert)', () => {
    expect(() =>
      buildEnvContent({
        adminUsername: 'admin-01',
        sandboxMode: 'process',
        providers: [{ kind: 'claude-apikey', apiKey: 'sk-$SECRET' }],
      }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  test('Route-apiKey mit Backslash wirft (würde die Folgezeile/nächstes Secret fressen)', () => {
    expect(() =>
      buildEnvContent({
        adminUsername: 'admin-01',
        sandboxMode: 'process',
        providers: [
          { kind: 'route', prefix: 'gpt-', upstreamUrl: 'https://api.openai.com', apiKey: 'k\\' },
        ],
      }),
    ).toThrow(/MACVIBES_MODEL_ROUTES/);
  });

  test('Wert mit einfachem Anführungszeichen wird klar abgelehnt (statt still korrumpiert)', () => {
    expect(() =>
      buildEnvContent({
        adminUsername: 'admin-01',
        sandboxMode: 'process',
        providers: [{ kind: 'claude-apikey', apiKey: "sk-'-broken" }],
      }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('sandboxModeFor — Aussperr-Absicherung des Sandbox-Backends', () => {
  test('msb vorhanden → microsandbox (voller VM-Modus)', () => {
    expect(sandboxModeFor(true)).toBe('microsandbox');
  });
  test('msb fehlt → process (klar benannter Fallback statt totem Zustand)', () => {
    expect(sandboxModeFor(false)).toBe('process');
  });
});

describe('doctor — reine Auswertung injizierter Prüf-Ergebnisse', () => {
  const gesund: DoctorInput = {
    bunVersion: '1.3.14',
    bunPin: '1.3.14',
    gitAvailable: true,
    msbAvailable: true,
    hypervisorAvailable: true,
    belegtePorts: [],
  };

  test('alles ok → keine Fehler, keine Warnungen', () => {
    const report = doctor(gesund);
    expect(report.hatFehler).toBe(false);
    expect(report.hatWarnung).toBe(false);
    expect(report.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  test('fehlendes bun ist ein harter Fehler mit Handlungshinweis', () => {
    const report = doctor({ ...gesund, bunVersion: null });
    const bun = report.checks.find((c) => c.id === 'bun');
    expect(bun?.status).toBe('fail');
    expect(bun?.hinweis.length).toBeGreaterThan(0);
    expect(report.hatFehler).toBe(true);
  });

  test('abweichende bun-Version warnt (Pin 1.3.14), blockiert aber nicht', () => {
    const report = doctor({ ...gesund, bunVersion: '1.4.0' });
    const bun = report.checks.find((c) => c.id === 'bun');
    expect(bun?.status).toBe('warn');
    expect(report.hatFehler).toBe(false);
    expect(report.hatWarnung).toBe(true);
  });

  test('fehlendes git ist ein harter Fehler', () => {
    const report = doctor({ ...gesund, gitAvailable: false });
    expect(report.checks.find((c) => c.id === 'git')?.status).toBe('fail');
    expect(report.hatFehler).toBe(true);
  });

  test('fehlendes msb ist nur eine Warnung (Prozess-Fallback existiert)', () => {
    const report = doctor({ ...gesund, msbAvailable: false });
    expect(report.checks.find((c) => c.id === 'msb')?.status).toBe('warn');
    expect(report.hatFehler).toBe(false);
  });

  test('msb da, aber kein Hypervisor → Warnung (VM kann nicht booten)', () => {
    const report = doctor({ ...gesund, hypervisorAvailable: false });
    expect(report.checks.find((c) => c.id === 'hypervisor')?.status).toBe('warn');
    expect(report.hatFehler).toBe(false);
  });

  test('ohne msb ist die Hypervisor-Prüfung nicht anwendbar (ok/übersprungen)', () => {
    const report = doctor({ ...gesund, msbAvailable: false, hypervisorAvailable: false });
    expect(report.checks.find((c) => c.id === 'hypervisor')?.status).toBe('ok');
  });

  test('belegte Ports warnen mit den konkreten Portnummern', () => {
    const report = doctor({ ...gesund, belegtePorts: [4000, 5173] });
    const ports = report.checks.find((c) => c.id === 'ports');
    expect(ports?.status).toBe('warn');
    expect(ports?.hinweis).toContain('4000');
    expect(ports?.hinweis).toContain('5173');
  });
});

// Referenz nur, damit die Typ-Importe (ProviderChoice) auch bei ungenutztem
// Alias nicht als tote Importe gelten — dokumentiert die öffentliche Form.
const _typRef: ProviderChoice = { kind: 'ollama' };
test('ProviderChoice-Typ ist importierbar', () => {
  expect(_typRef.kind).toBe('ollama');
});
