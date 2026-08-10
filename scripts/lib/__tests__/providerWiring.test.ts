/**
 * Verdrahtung erkannter Anbieter — test-first (CLAUDE.md). Reine Logik:
 * Env-Namensableitung, nicht-destruktives Ergänzen von models.json und die
 * Erzeugung der litellm.yaml aus der mitgelieferten Basis (Catch-all bleibt
 * LETZTER Eintrag, sonst verschluckt er alle Nutzer-Modelle).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  envVarName,
  litellmYamlMitEintrag,
  modelsJsonMitEintrag,
  type LitellmEintrag,
} from '../providerWiring';

describe('envVarName — Env-Variablenname aus dem Anzeigenamen', () => {
  const keine = new Set<string>();

  test('einfacher Name → GROSS + _API_KEY (OpenRouter → OPENROUTER_API_KEY)', () => {
    // Bewusste Konvergenz: die mitgelieferte litellm_config.yaml liest für ihre
    // OpenRouter-Beispiele genau OPENROUTER_API_KEY.
    expect(envVarName('OpenRouter', keine)).toBe('OPENROUTER_API_KEY');
  });

  test('Sonderzeichen/Leerzeichen werden zu _ zusammengefasst', () => {
    expect(envVarName('Mistral AI', keine)).toBe('MISTRAL_AI_API_KEY');
    expect(envVarName('mein-server.local', keine)).toBe('MEIN_SERVER_LOCAL_API_KEY');
    expect(envVarName('  Grok!!  ', keine)).toBe('GROK_API_KEY');
  });

  test('nur erlaubte Zeichen [A-Z0-9_] im Ergebnis', () => {
    expect(envVarName('Ünicode & Co. GmbH', keine)).toMatch(/^[A-Z0-9_]+$/);
  });

  test('leerer/unbrauchbarer Name → generischer Fallback', () => {
    expect(envVarName('!!!', keine)).toBe('ANBIETER_API_KEY');
  });

  test('führende Ziffer wird entschärft (Env-Namen dürfen nicht mit Ziffer beginnen)', () => {
    expect(envVarName('42ai', keine)).toMatch(/^[A-Z_]/);
  });

  test('Kollision mit vergebenem Namen → nummerierter Suffix', () => {
    const vergeben = new Set(['ACME_API_KEY']);
    expect(envVarName('Acme', vergeben)).toBe('ACME_API_KEY_2');
    vergeben.add('ACME_API_KEY_2');
    expect(envVarName('Acme', vergeben)).toBe('ACME_API_KEY_3');
  });

  test('ANTHROPIC_API_KEY ist reserviert (Claude-Key des Proxys) → Suffix', () => {
    expect(envVarName('Anthropic', keine)).toBe('ANTHROPIC_API_KEY_2');
  });

  test('MACVIBES_-Präfix ist Server-Konfiguration → wird entschärft', () => {
    expect(envVarName('macvibes zwei', keine)).not.toMatch(/^MACVIBES/);
  });
});

describe('modelsJsonMitEintrag — nicht-destruktives Ergänzen', () => {
  const eintrag = { id: 'acme-modell', label: 'Acme (Acme AI)', slow: true };

  test('keine Datei (null) → neues Array mit genau dem Eintrag', () => {
    const ergebnis = modelsJsonMitEintrag(null, eintrag);
    expect(ergebnis.geaendert).toBe(true);
    expect(JSON.parse(ergebnis.inhalt)).toEqual([eintrag]);
    expect(ergebnis.inhalt.endsWith('\n')).toBe(true);
  });

  test('bestehende Einträge bleiben unangetastet, der neue kommt hinten dazu', () => {
    const bestehend = JSON.stringify([{ id: 'alt', label: 'Alt', slow: false }]);
    const ergebnis = modelsJsonMitEintrag(bestehend, eintrag);
    expect(JSON.parse(ergebnis.inhalt)).toEqual([
      { id: 'alt', label: 'Alt', slow: false },
      eintrag,
    ]);
  });

  test('id schon vorhanden → unverändert, mit Hinweis statt Duplikat', () => {
    const bestehend = JSON.stringify([eintrag]);
    const ergebnis = modelsJsonMitEintrag(bestehend, eintrag);
    expect(ergebnis.geaendert).toBe(false);
    expect(ergebnis.inhalt).toBe(bestehend);
    expect(ergebnis.hinweis).toContain('acme-modell');
  });

  test('kaputtes JSON → NICHT anfassen (Nutzerdatei nie zerstören), klarer Hinweis', () => {
    const kaputt = '{ kein json [';
    const ergebnis = modelsJsonMitEintrag(kaputt, eintrag);
    expect(ergebnis.geaendert).toBe(false);
    expect(ergebnis.inhalt).toBe(kaputt);
    expect(ergebnis.hinweis).toBeDefined();
  });

  test('JSON, aber kein Array → ebenfalls nicht anfassen', () => {
    const ergebnis = modelsJsonMitEintrag('{"id":"x"}', eintrag);
    expect(ergebnis.geaendert).toBe(false);
    expect(ergebnis.hinweis).toBeDefined();
  });
});

/** Mitgelieferte Router-Config — die ECHTE Datei als Basis (kein Hand-Modell). */
const BUNDLED_YAML = readFileSync(
  join(
    fileURLToPath(new URL('.', import.meta.url)),
    '..',
    '..',
    '..',
    'apps',
    'server',
    'local-router',
    'litellm_config.yaml',
  ),
  'utf8',
);

const EINTRAG: LitellmEintrag = {
  modelName: 'qwen/qwen3-coder',
  litellmModel: 'openai/qwen/qwen3-coder',
  apiBase: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  kommentar: 'OpenRouter',
};

/** Position des Catch-alls und aller model_name-Zeilen im YAML-Text. */
function modelNameZeilen(yaml: string): string[] {
  return yaml
    .split('\n')
    .filter((zeile) => /^\s*-\s*model_name:/.test(zeile))
    .map((zeile) => zeile.trim());
}

describe('litellmYamlMitEintrag — Basis + Nutzer-Eintrag, Catch-all bleibt letzter', () => {
  test('der neue Eintrag steht VOR dem Catch-all, alle Basis-Einträge bleiben', () => {
    const ergebnis = litellmYamlMitEintrag(BUNDLED_YAML, EINTRAG);
    expect(ergebnis.geaendert).toBe(true);
    const zeilen = modelNameZeilen(ergebnis.inhalt);
    // Ollama-Basis-Einträge unverändert vorhanden:
    expect(zeilen).toContain('- model_name: qwen3.6-coder');
    expect(zeilen).toContain('- model_name: qwen3.6-moe');
    // Neuer Eintrag vorhanden — und der Catch-all ist die LETZTE model_name-Zeile:
    expect(zeilen).toContain("- model_name: 'qwen/qwen3-coder'");
    expect(zeilen[zeilen.length - 1]).toBe("- model_name: '*'");
  });

  test('litellm_params des Eintrags: model, api_base und api_key via os.environ', () => {
    const { inhalt } = litellmYamlMitEintrag(BUNDLED_YAML, EINTRAG);
    expect(inhalt).toContain("model: 'openai/qwen/qwen3-coder'");
    expect(inhalt).toContain("api_base: 'https://openrouter.ai/api/v1'");
    expect(inhalt).toContain('api_key: os.environ/OPENROUTER_API_KEY');
  });

  test('die Abschnitte nach model_list (litellm_settings etc.) bleiben erhalten', () => {
    const { inhalt } = litellmYamlMitEintrag(BUNDLED_YAML, EINTRAG);
    expect(inhalt).toContain('litellm_settings:');
    expect(inhalt).toContain('general_settings:');
    // Der Eintrag darf NICHT hinter litellm_settings gerutscht sein:
    expect(inhalt.indexOf("- model_name: 'qwen/qwen3-coder'")).toBeLessThan(
      inhalt.indexOf('litellm_settings:'),
    );
  });

  test('model_name schon vorhanden → unverändert, mit Hinweis', () => {
    const einmal = litellmYamlMitEintrag(BUNDLED_YAML, EINTRAG).inhalt;
    const zweimal = litellmYamlMitEintrag(einmal, EINTRAG);
    expect(zweimal.geaendert).toBe(false);
    expect(zweimal.inhalt).toBe(einmal);
    expect(zweimal.hinweis).toContain('qwen/qwen3-coder');
  });

  test('Basis ohne Catch-all (Nutzerdatei) → Einfügen vor litellm_settings + Warnhinweis', () => {
    const ohneCatchall = `model_list:
  - model_name: eigenes
    litellm_params:
      model: ollama_chat/eigenes
      api_base: http://localhost:11434

litellm_settings:
  drop_params: true
`;
    const ergebnis = litellmYamlMitEintrag(ohneCatchall, EINTRAG);
    expect(ergebnis.geaendert).toBe(true);
    expect(ergebnis.inhalt.indexOf("- model_name: 'qwen/qwen3-coder'")).toBeLessThan(
      ergebnis.inhalt.indexOf('litellm_settings:'),
    );
    // Fehlender Catch-all wird gemeldet (Claude Codes Hilfsmodelle brauchen ihn):
    expect(ergebnis.hinweis).toBeDefined();
  });

  test('Basis ohne Catch-all und ohne Folge-Abschnitte → ans Ende anhängen', () => {
    const minimal = `model_list:
  - model_name: eigenes
    litellm_params:
      model: ollama_chat/eigenes
`;
    const ergebnis = litellmYamlMitEintrag(minimal, EINTRAG);
    expect(ergebnis.geaendert).toBe(true);
    expect(modelNameZeilen(ergebnis.inhalt)).toContain("- model_name: 'qwen/qwen3-coder'");
  });

  test('YAML-Single-Quoting: einfache Anführungszeichen im Wert werden verdoppelt', () => {
    const { inhalt } = litellmYamlMitEintrag(BUNDLED_YAML, {
      ...EINTRAG,
      modelName: "o'brien-1",
      litellmModel: "openai/o'brien-1",
    });
    expect(inhalt).toContain("- model_name: 'o''brien-1'");
  });
});
