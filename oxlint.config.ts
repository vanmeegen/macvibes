import { defineConfig } from 'oxlint';

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
 *   app (index.ts, shutdownSequence.ts,
 *        devHotReload.ts)                      ← Composition Root, darf alles
 *
 * Schichtung Web: pages → models → api, keine Rückkanten.
 */
const serverElements = [
  // Reihenfolge zählt: spezifischere Muster zuerst, sonst schluckt ein
  // Ordner-Muster die Dateien. Tests werden eigenständig klassifiziert (s. u.).
  // `src/testing/` sind die geteilten Test-Hilfen (DB, Temp-Verzeichnisse,
  // Fixtures) — bewusst außerhalb jeder Schicht, weil Tests ALLER Schichten
  // sie nutzen (vorher lagen sie unter services/__tests__).
  // oxlint kennt Settings nur global: Server und Web teilen sich deshalb EIN
  // test-Element, alle übrigen Muster sind auf ihre App verankert.
  {
    type: 'test',
    partialMatch: false,
    pattern: ['**/__tests__/**', '**/apps/server/src/testing/**'],
  },
  // Composition Root: verdrahtet alle Schichten, darf deshalb alles.
  // devHotReload gehört zur Composition Root: es räumt beim `bun --hot`-Reload
  // genau die Ressourcen ab bzw. übergibt sie, die index.ts verdrahtet — dafür
  // braucht es deren Typen (core/vmTokens, services/localRouterService).
  {
    type: 'app',
    mode: 'file',
    pattern: [
      '**/apps/server/src/index.ts',
      '**/apps/server/src/shutdownSequence.ts',
      '**/apps/server/src/devHotReload.ts',
    ],
  },
  // Querschnitts-Dateien ohne eigene Abhängigkeiten (Konfiguration, Log-Hygiene):
  // jede Schicht darf sie nutzen, sie selbst importieren nichts aus dem Projekt.
  {
    type: 'base-file',
    mode: 'file',
    pattern: ['**/apps/server/src/config.ts', '**/apps/server/src/logSafe.ts'],
  },
  { type: 'core', partialMatch: false, pattern: ['**/apps/server/src/core/**'] },
  { type: 'preview', partialMatch: false, pattern: ['**/apps/server/src/preview/**'] },
  { type: 'db', partialMatch: false, pattern: ['**/apps/server/src/db/**'] },
  { type: 'sandbox', partialMatch: false, pattern: ['**/apps/server/src/sandbox/**'] },
  { type: 'agent', partialMatch: false, pattern: ['**/apps/server/src/agent/**'] },
  { type: 'services', partialMatch: false, pattern: ['**/apps/server/src/services/**'] },
  { type: 'schema', partialMatch: false, pattern: ['**/apps/server/src/schema/**'] },
  { type: 'http', partialMatch: false, pattern: ['**/apps/server/src/http/**'] },
];

/** Web: strikte Kette pages → models → api, keine Rückkanten. */
const webElements = [
  // Composition Root des SPA: App/main verdrahten Router, Stores und Theme.
  {
    type: 'web-app',
    mode: 'file',
    pattern: ['**/apps/web/src/App.tsx', '**/apps/web/src/main.tsx', '**/apps/web/src/theme.ts'],
  },
  { type: 'api', partialMatch: false, pattern: ['**/apps/web/src/api/**'] },
  { type: 'speech', partialMatch: false, pattern: ['**/apps/web/src/speech/**'] },
  { type: 'models', partialMatch: false, pattern: ['**/apps/web/src/models/**'] },
  { type: 'pages', partialMatch: false, pattern: ['**/apps/web/src/pages/**'] },
];

const serverRules = [
  // Tests sind Mini-Composition-Roots: Integrationstests (z. B.
  // daemonTransport.msb) verdrahten bewusst mehrere Schichten und nutzen
  // Test-Utilities über Schichtgrenzen. Die Produktions-Schichtung wird
  // dadurch nicht schwächer — sie gilt für allen Nicht-Test-Code strikt.
  { from: 'test', allow: [...serverElements, ...webElements].map((e) => e.type) },
  // Composition Root: instanziiert und verdrahtet alle Schichten.
  { from: 'app', allow: serverElements.map((e) => e.type) },
  // core = Basisschicht (Fehler, Workspace-Pfade, git-Wrapper, Prozess-
  // Supervisor, Host↔VM-Vertrag):
  // → preview: der ProcessSupervisor meldet seinen Lebenszyklus im geteilten
  //   Status-Vokabular (preview/status), das wegen des VM-Bundles selbst
  //   importfrei bleiben muss.
  // Die frühere Kante → db wurde bewusst gestrichen: sie war im Importgraphen
  // tot, und eine Basisschicht, die Persistenz kennt, wäre auch im Zielbild
  // ein Rückschritt. Jede ungenutzte Erlaubnis ist ein Loch im Gate — bei
  // echtem Bedarf hier begründet wieder eintragen. Dasselbe gilt für
  // `base-file` (config/logSafe): außer agent (logSafe im Gateway) liest es
  // keine Schicht unterhalb von schema/http — die Erlaubnis ist dort gestrichen.
  { from: 'core', allow: ['preview'] },
  // preview ist das geteilte Status-Vokabular zwischen Host und VM-Daemon
  // (wird ins VM-Bundle gebündelt) — es darf GAR NICHTS importieren.
  { from: 'preview', allow: [] },
  // db kapselt Drizzle/SQLite und kennt keine höheren Schichten.
  { from: 'db', allow: [] },
  // sandbox (VM-/Prozess-Provider) und agent (Runner/Daemon/Gateway) sind
  // Geschwister über core: beide bauen auf Basisschicht + Status-Vokabular,
  // keiner kennt services, schema oder http — und einander auch nicht.
  // Persistenz (db) kennt keiner von beiden: die Kante war im Importgraphen
  // tot und ist gestrichen.
  { from: 'sandbox', allow: ['core', 'preview'] },
  { from: 'agent', allow: ['core', 'preview', 'base-file'] },
  // services orchestrieren Fachlichkeit über agent und persistieren in db.
  // Sie kennen weder GraphQL (schema) noch HTTP. Die frühere Kante → sandbox
  // wurde bewusst gestrichen: kein Service importiert sandbox mehr — die
  // Sandbox-Orchestrierung liegt heute in schema (chatEvents-Subscription).
  // Bei echtem Bedarf hier begründet wieder eintragen.
  { from: 'services', allow: ['core', 'agent', 'db'] },
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

/**
 * Übersetzt die lesbare Matrix oben in boundaries-v7-Policies. Importe
 * INNERHALB der eigenen Schicht sind dabei immer erlaubt — deshalb steht
 * jede Schicht implizit in ihrer eigenen allow-Liste.
 */
const toPolicies = (rules: { from: string; allow: string[] }[]) =>
  rules.map((r) => ({
    from: { element: { type: r.from } },
    allow: { to: { element: { types: { anyOf: [r.from, ...r.allow] } } } },
  }));

const webRules = [
  { from: 'web-app', allow: webElements.map((e) => e.type) },
  // api (GraphQL-Client + handgepflegte Typen in api/types.ts — KEIN Codegen)
  // ist die unterste Schicht: importiert NICHTS aus models/pages.
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

const M3 = {
  // patterns-GRUPPE, nicht exakte paths-Namen: ein `name: 'graphql'` fängt nur
  // den exakten String, aber `graphql/error` exportiert GraphQLError genauso.
  group: ['graphql', 'graphql/*', 'graphql-yoga', 'graphql-yoga/*', '@pothos/*'],
  message:
    'M3: Präsentationstechnik (GraphQL/Yoga/Pothos) gehört nur in schema/ und http/. Die Basisschichten müssen graphql-frei bleiben (DomainError darf nie wieder GraphQLError erben).',
};
const M1 = [
  {
    // Gruppe statt exaktem Namen: `drizzle-orm/sql` exportiert eq/and/sql und
    // ließe im Resolver ein `ctx.db.run(sql`update …`)` zu.
    group: ['drizzle-orm', 'drizzle-orm/*'],
    message:
      'M1: schema/ ist Transport — kein ausführbarer DB-Zugriff. drizzle-orm (eq, sql, db.update …) gehört in services/db, nicht in Resolver.',
  },
  {
    group: ['**/db/client', '**/db/schema'],
    allowTypeImports: true,
    message:
      'M1: schema/ darf db NUR als Typ kennen (import type { Db, UserRow, ChatMessageRow }). Ein Wert-Import (Tabellen, Client) ist ausführbarer DB-Zugriff im Transport.',
  },
];
const KEINE_SCRIPTS = {
  group: ['**/scripts/**'],
  message:
    'src/ darf nicht aus dem Top-Level-scripts/ importieren (Composition-Root-artige Skripte, keine Schicht). Gemeinsamen Code nach packages/shared ziehen.',
};

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc', 'react'],
  // Der Regelsatz unten entspricht dem früheren ESLint-Stand (eslint
  // recommended + typescript-eslint recommended), ausgeschrieben statt über
  // Kategorien, damit ein oxlint-Update nicht still neue Regeln scharf schaltet.
  categories: { correctness: 'off' },
  env: { builtin: true, es2022: true },
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    'templates/**',
    'apps/server/drizzle/**',
    'apps/server/data/**',
  ],
  // Das Architektur-Gate läuft als ESLint-kompatibles JS-Plugin in oxlint.
  jsPlugins: ['eslint-plugin-boundaries'],
  settings: {
    'import/resolver': {
      // Löst relative Importe ohne Endung auf .ts auf — ohne Resolver sähe
      // das Gate keine einzige Kante.
      node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
    },
    'boundaries/elements': [...serverElements, ...webElements],
    // Einzeldatei-Elemente (app, base-file) gehen in v7 nur über die
    // Legacy-Deskriptoren mit `mode: 'file'` — deren Deprecation-Warnung
    // würde sonst jeden Lauf fluten.
    'boundaries/legacy-warnings': false,
  },
  rules: {
    'constructor-super': 'error',
    'for-direction': 'error',
    'getter-return': 'error',
    'no-async-promise-executor': 'error',
    'no-case-declarations': 'error',
    'no-class-assign': 'error',
    'no-compare-neg-zero': 'error',
    'no-cond-assign': 'error',
    'no-const-assign': 'error',
    'no-constant-binary-expression': 'error',
    'no-constant-condition': 'error',
    'no-control-regex': 'error',
    'no-debugger': 'error',
    'no-delete-var': 'error',
    'no-dupe-class-members': 'error',
    'no-dupe-else-if': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-empty': 'error',
    'no-empty-character-class': 'error',
    'no-empty-pattern': 'error',
    'no-empty-static-block': 'error',
    'no-ex-assign': 'error',
    'no-extra-boolean-cast': 'error',
    'no-fallthrough': 'error',
    'no-func-assign': 'error',
    'no-global-assign': 'error',
    'no-import-assign': 'error',
    'no-invalid-regexp': 'error',
    'no-irregular-whitespace': 'error',
    'no-loss-of-precision': 'error',
    'no-misleading-character-class': 'error',
    'no-new-native-nonconstructor': 'error',
    'no-nonoctal-decimal-escape': 'error',
    'no-obj-calls': 'error',
    'no-prototype-builtins': 'error',
    'no-redeclare': 'error',
    'no-regex-spaces': 'error',
    'no-self-assign': 'error',
    'no-setter-return': 'error',
    'no-shadow-restricted-names': 'error',
    'no-sparse-arrays': 'error',
    'no-this-before-super': 'error',
    'no-unassigned-vars': 'error',
    'no-unexpected-multiline': 'error',
    'no-unreachable': 'error',
    'no-unsafe-finally': 'error',
    'no-unsafe-negation': 'error',
    'no-unsafe-optional-chaining': 'error',
    'no-unused-labels': 'error',
    'no-unused-private-class-members': 'error',
    'no-unused-vars': 'error',
    'no-useless-backreference': 'error',
    'no-useless-catch': 'error',
    'no-useless-escape': 'error',
    'no-with': 'error',
    'preserve-caught-error': 'error',
    'require-yield': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
    'no-array-constructor': 'error',
    'no-unused-expressions': 'error',
    'typescript/ban-ts-comment': 'error',
    'typescript/no-duplicate-enum-values': 'error',
    'typescript/no-empty-object-type': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-extra-non-null-assertion': 'error',
    'typescript/no-misused-new': 'error',
    'typescript/no-namespace': 'error',
    'typescript/no-non-null-asserted-optional-chain': 'error',
    'typescript/no-require-imports': 'error',
    'typescript/no-this-alias': 'error',
    'typescript/no-unnecessary-type-constraint': 'error',
    'typescript/no-unsafe-declaration-merging': 'error',
    'typescript/no-unsafe-function-type': 'error',
    'typescript/no-wrapper-object-types': 'error',
    'typescript/prefer-as-const': 'error',
    'typescript/prefer-namespace-keyword': 'error',
    'typescript/triple-slash-reference': 'error',
    'no-useless-assignment': 'error',
  },
  overrides: [
    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      rules: {
        ...{
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-var': 'error',
          'no-with': 'off',
          'prefer-const': 'error',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
        'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        'typescript/consistent-type-imports': 'error',
      },
    },
    {
      files: ['apps/web/**/*.{ts,tsx}'],
      env: { browser: true },
      rules: {
        'react/rules-of-hooks': 'error',
        'react/exhaustive-deps': 'warn',
        // React-Compiler-Regeln (früher eslint-plugin-react-hooks recommended).
        'react/static-components': 'error',
        'react/use-memo': 'error',
        'react/preserve-manual-memoization': 'error',
        'react/incompatible-library': 'warn',
        'react/immutability': 'error',
        'react/globals': 'error',
        'react/refs': 'error',
        'react/set-state-in-effect': 'error',
        'react/error-boundaries': 'error',
        'react/purity': 'error',
        'react/set-state-in-render': 'error',
        'react/unsupported-syntax': 'warn',
        'react/only-export-components': ['warn', { allowConstantExport: true }],
      },
    },
    {
      files: ['apps/server/**/*.ts'],
      env: { node: true },
      globals: { Bun: 'readonly' },
    },
    // ─── Architektur-Gate ───────────────────────────────────────────────────
    // Bewusst NUR src/: die Skripte (apps/server/scripts/buildBaselines.ts,
    // top-level scripts/) sind Composition-Root-artig — sie verdrahten
    // Schichten, gehören also selbst keiner an.
    {
      files: ['apps/server/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}'],
      rules: {
        'boundaries/dependencies': [
          'error',
          { default: 'disallow', policies: toPolicies([...serverRules, ...webRules]) },
        ],
      },
    },
    // ─── npm-Grenzen, die boundaries NICHT sieht ────────────────────────────
    // boundaries kennt nur Projekt-Kanten (Datei→Datei); npm-Pakete sind ihm
    // unsichtbar. oxlint mischt die Optionen einer Regel über mehrere Blöcke
    // NICHT, der letzte Treffer gewinnt — darum trägt jeder Block die
    // vollständige Liste für seine Dateimenge, vom Allgemeinen zum Speziellen:
    //
    // H4 — ganz src/ darf nicht aus dem Top-Level-`scripts/` importieren.
    {
      files: ['apps/server/src/**/*.ts'],
      rules: { 'no-restricted-imports': ['error', { patterns: [KEINE_SCRIPTS] }] },
    },
    // H1 (M3) — core & untere Schichten dürfen die Präsentationstechnik GraphQL
    // nicht kennen. NUR schema/ und http/ dürfen graphql/yoga/pothos kennen.
    {
      files: ['apps/server/src/{core,preview,sandbox,agent,services}/**/*.ts'],
      rules: { 'no-restricted-imports': ['error', { patterns: [KEINE_SCRIPTS, M3] }] },
    },
    // H3 (M1) — kein ausführbarer DB-Zugriff im Transport. Die Kante schema→db
    // ist bewusst erlaubt (Resolver brauchen die Row-TYPEN), ein WERT-Import
    // aus db/ oder aus drizzle-orm bricht.
    {
      files: ['apps/server/src/schema/**/*.ts'],
      rules: { 'no-restricted-imports': ['error', { patterns: [KEINE_SCRIPTS, ...M1] }] },
    },
    // H2 (M6) — Env-Reads nur in config.ts. Greift auf jeden
    // `Bun.env`/`process.env`-Zugriff. Grenze der Regel: ein Alias des GLOBALS
    // selbst (`const e = Bun; e.env.X`) oder der Umweg über `globalThis`
    // entkäme ihr — über den Review gedeckt.
    {
      files: ['apps/server/src/**/*.ts'],
      rules: {
        'no-restricted-properties': [
          'error',
          {
            object: 'Bun',
            property: 'env',
            message:
              'M6: Env nur in config.ts lesen. Neue Konfiguration dort über loadConfig() ergänzen, nicht direkt Bun.env greifen.',
          },
          {
            object: 'process',
            property: 'env',
            message:
              'M6: Env nur in config.ts lesen. Neue Konfiguration dort über loadConfig() ergänzen, nicht direkt process.env greifen.',
          },
        ],
      },
    },
    // H2-Ausnahmen: hier IST der Env-Read legitim.
    {
      files: [
        // Die eine Quelle der Konfiguration.
        'apps/server/src/config.ts',
        // Der Agent-Daemon läuft IN der VM — Env ist dort der Host→VM-Transport.
        'apps/server/src/agent/daemon/**',
        // gitService und processProvider spreaden nur `...process.env` an
        // Kindprozesse — sie LESEN keine einzelne Variable.
        'apps/server/src/core/gitService.ts',
        'apps/server/src/sandbox/processProvider.ts',
      ],
      rules: { 'no-restricted-properties': 'off' },
    },
    // Tests sind von H1–H4 ausgenommen (das test-Element hat laut Matrix
    // Vollzugriff): sie importieren GraphQLError, Tabellen oder scripts/lib
    // bewusst, um genau diese Grenzen zu beweisen, und setzen Env gezielt.
    // Dieser Block MUSS nach H1–H4 stehen.
    {
      files: ['apps/server/src/**/__tests__/**'],
      rules: { 'no-restricted-imports': 'off', 'no-restricted-properties': 'off' },
    },
  ],
});
