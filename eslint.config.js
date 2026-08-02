import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Architektur-Gate (Build-Breaker): erzwingt die Schichtung beider Apps.
 *
 * Die Regelmatrix hier IST die Architektur-Doku — jede erlaubte Kante trägt
 * einen Satz, warum sie existiert. Alles nicht explizit Erlaubte ist verboten
 * (`default: 'disallow'`); eine neue Kante einzuführen heißt, sie hier
 * bewusst und begründet einzutragen.
 *
 * Schichtung Server (eine Richtung, keine Gegenkanten):
 *
 *   preview, db, base-file (config/logSafe)   ← Basis, importiert nichts Höheres
 *        ↑
 *      core                                    ← Basisschicht (Fehler, Pfade, Prozess-Supervisor, VM-Vertrag)
 *        ↑
 *   sandbox, agent                             ← Geschwister, importieren einander NICHT
 *        ↑
 *    services
 *        ↑
 *     schema
 *        ↑
 *      http
 *        ↑
 *   app (index.ts, shutdownSequence.ts)        ← Composition Root, darf alles
 *
 * Schichtung Web: pages → models → api, keine Rückkanten.
 */
const serverElements = [
  // Reihenfolge zählt: spezifischere Muster zuerst, sonst schluckt ein
  // Ordner-Muster die Dateien. Tests werden eigenständig klassifiziert (s. u.).
  { type: 'test', partialMatch: false, pattern: ['**/__tests__/**'] },
  // Composition Root: verdrahtet alle Schichten, darf deshalb alles.
  { type: 'app', mode: 'file', pattern: ['**/src/index.ts', '**/src/shutdownSequence.ts'] },
  // Querschnitts-Dateien ohne eigene Abhängigkeiten (Konfiguration, Log-Hygiene):
  // jede Schicht darf sie nutzen, sie selbst importieren nichts aus dem Projekt.
  { type: 'base-file', mode: 'file', pattern: ['**/src/config.ts', '**/src/logSafe.ts'] },
  { type: 'core', partialMatch: false, pattern: ['**/src/core/**'] },
  { type: 'preview', partialMatch: false, pattern: ['**/src/preview/**'] },
  { type: 'db', partialMatch: false, pattern: ['**/src/db/**'] },
  { type: 'sandbox', partialMatch: false, pattern: ['**/src/sandbox/**'] },
  { type: 'agent', partialMatch: false, pattern: ['**/src/agent/**'] },
  { type: 'services', partialMatch: false, pattern: ['**/src/services/**'] },
  { type: 'schema', partialMatch: false, pattern: ['**/src/schema/**'] },
  { type: 'http', partialMatch: false, pattern: ['**/src/http/**'] },
];

const serverRules = [
  // Tests sind Mini-Composition-Roots: Integrationstests (z. B.
  // daemonTransport.msb) verdrahten bewusst mehrere Schichten und nutzen
  // Test-Utilities über Schichtgrenzen. Die Produktions-Schichtung wird
  // dadurch nicht schwächer — sie gilt für allen Nicht-Test-Code strikt.
  { from: 'test', allow: serverElements.map((e) => e.type) },
  // Composition Root: instanziiert und verdrahtet alle Schichten.
  { from: 'app', allow: serverElements.map((e) => e.type) },
  // core = Basisschicht (Fehler, Workspace-Pfade, git-Wrapper, Prozess-
  // Supervisor, Host↔VM-Vertrag):
  // → preview: der ProcessSupervisor meldet seinen Lebenszyklus im geteilten
  //   Status-Vokabular (preview/status), das wegen des VM-Bundles selbst
  //   importfrei bleiben muss.
  // → db: erlaubt laut Zielbild (aktuell ungenutzt).
  { from: 'core', allow: ['preview', 'db', 'base-file'] },
  // preview ist das geteilte Status-Vokabular zwischen Host und VM-Daemon
  // (wird ins VM-Bundle gebündelt) — es darf GAR NICHTS importieren.
  { from: 'preview', allow: [] },
  // db kapselt Drizzle/SQLite und kennt keine höheren Schichten.
  { from: 'db', allow: ['base-file'] },
  // sandbox (VM-/Prozess-Provider) und agent (Runner/Daemon/Gateway) sind
  // Geschwister über core: beide bauen auf Basisschicht + Status-Vokabular,
  // keiner kennt services, schema oder http — und einander auch nicht.
  { from: 'sandbox', allow: ['core', 'preview', 'db', 'base-file'] },
  { from: 'agent', allow: ['core', 'preview', 'db', 'base-file'] },
  // services orchestrieren Fachlichkeit über agent + sandbox und persistieren
  // in db. Sie kennen weder GraphQL (schema) noch HTTP.
  { from: 'services', allow: ['core', 'agent', 'sandbox', 'db', 'base-file'] },
  // schema (GraphQL-Resolver):
  // → services/db/core: Fachlogik, Persistenz-Typen, DomainError.
  // → agent: Modellkatalog (agentModel) für die Modellwahl im UI.
  // → sandbox: der GraphQLContext trägt den SandboxManager, und die
  //   chatEvents-Subscription steuert den Sandbox-Lebenszyklus direkt
  //   (enter/leave/viewerKey). Bewusste Erweiterung des Zielbilds — die
  //   Kante ist real und zeigt abwärts, keine Gegenkante.
  // KEIN http mehr: Session-Cookies laufen als Fähigkeiten über den
  // GraphQLContext (ctx.session.*), befüllt in http/createAppYoga.
  { from: 'schema', allow: ['core', 'services', 'db', 'agent', 'sandbox', 'base-file'] },
  // http (äußerste Schicht unterhalb der Composition Root):
  // → schema: createAppYoga braucht das ausführbare Schema + den Context-Typ.
  // → services: Session-Auflösung (authService) und ChatService-Typ für die
  //   Context-Erzeugung.
  // → sandbox: SandboxManager-Typ für die Yoga-Dependencies.
  // → db: Db-Typ für die Context-Erzeugung.
  // → core: Host↔VM-Vertrag (vmContract) im Credential-Proxy.
  { from: 'http', allow: ['core', 'db', 'services', 'schema', 'sandbox', 'base-file'] },
];

/** Web: strikte Kette pages → models → api, keine Rückkanten. */
const webElements = [
  { type: 'test', partialMatch: false, pattern: ['**/__tests__/**'] },
  // Composition Root des SPA: App/main verdrahten Router, Stores und Theme.
  {
    type: 'web-app',
    mode: 'file',
    pattern: ['**/src/App.tsx', '**/src/main.tsx', '**/src/theme.ts'],
  },
  { type: 'api', partialMatch: false, pattern: ['**/src/api/**'] },
  { type: 'speech', partialMatch: false, pattern: ['**/src/speech/**'] },
  { type: 'models', partialMatch: false, pattern: ['**/src/models/**'] },
  { type: 'pages', partialMatch: false, pattern: ['**/src/pages/**'] },
];

/**
 * Übersetzt die lesbare Matrix oben in boundaries-v7-Policies. Importe
 * INNERHALB der eigenen Schicht sind dabei immer erlaubt — deshalb steht
 * jede Schicht implizit in ihrer eigenen allow-Liste.
 */
const toPolicies = (rules) =>
  rules.map((r) => ({
    from: { element: { type: r.from } },
    allow: { to: { element: { types: { anyOf: [r.from, ...r.allow] } } } },
  }));

const webRules = [
  { from: 'test', allow: webElements.map((e) => e.type) },
  { from: 'web-app', allow: webElements.map((e) => e.type) },
  // api (GraphQL-Client + generierte Typen) ist die unterste Schicht:
  // importiert NICHTS aus models/pages.
  { from: 'api', allow: [] },
  // speech kapselt die Web-Speech-API ohne Kenntnis der App.
  { from: 'speech', allow: [] },
  // models (MobX-Stores) reden mit dem Backend (api) und der Spracheingabe.
  { from: 'models', allow: ['api', 'speech'] },
  // pages rendern models; api-TYPEN direkt zu nutzen ist erlaubt (reale,
  // abwärts gerichtete Kante — ChatPage/ProjectsPage nutzen GraphQL-Typen),
  // eine Rückkante models/pages ← api bleibt verboten.
  { from: 'pages', allow: ['models', 'api'] },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'templates/**',
      'apps/server/drizzle/**',
      'apps/server/data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, Bun: 'readonly' },
    },
  },
  // ─── Architektur-Gate Server ────────────────────────────────────────────
  {
    files: ['apps/server/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        // Löst relative Importe ohne Endung auf .ts auf — ohne Resolver sähe
        // das Gate keine einzige Kante.
        node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
      },
      'boundaries/elements': serverElements,
      // Einzeldatei-Elemente (app, base-file) gehen in v7 nur über die
      // Legacy-Deskriptoren mit `mode: 'file'` — deren Deprecation-Warnung
      // würde sonst jeden CI-Lauf fluten.
      'boundaries/legacy-warnings': false,
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        { default: 'disallow', policies: toPolicies(serverRules) },
      ],
    },
  },
  // ─── Architektur-Gate Web ───────────────────────────────────────────────
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
      },
      'boundaries/elements': webElements,
      // s. Server-Block: Einzeldatei-Elemente brauchen die Legacy-Deskriptoren.
      'boundaries/legacy-warnings': false,
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', policies: toPolicies(webRules) }],
    },
  },
);
