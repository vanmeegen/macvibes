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
  // Die frühere Kante → db wurde bewusst gestrichen: sie war im Importgraphen
  // tot, und eine Basisschicht, die Persistenz kennt, wäre auch im Zielbild
  // ein Rückschritt. Jede ungenutzte Erlaubnis ist ein Loch im Gate — bei
  // echtem Bedarf hier begründet wieder eintragen.
  { from: 'core', allow: ['preview', 'base-file'] },
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
  // services orchestrieren Fachlichkeit über agent und persistieren in db.
  // Sie kennen weder GraphQL (schema) noch HTTP. Die frühere Kante → sandbox
  // wurde bewusst gestrichen: kein Service importiert sandbox mehr — die
  // Sandbox-Orchestrierung liegt heute in schema (chatEvents-Subscription).
  // Bei echtem Bedarf hier begründet wieder eintragen.
  { from: 'services', allow: ['core', 'agent', 'db', 'base-file'] },
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
  // Bewusst NUR src/: die Skripte (apps/server/scripts/buildBaselines.ts,
  // top-level scripts/) sind Composition-Root-artig — sie verdrahten Schichten,
  // gehören also selbst keiner an und importieren begründet schichtenfrei.
  // Sie stehen darum außerhalb der boundaries-Elemente statt als Ausnahme drin.
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
  // ─── npm-Grenzen, die boundaries NICHT sieht ────────────────────────────
  // boundaries kennt nur Projekt-Kanten (Datei→Datei); npm-Pakete sind ihm
  // unsichtbar. Die folgenden Blöcke schließen genau die Lücken, in denen eine
  // Schichtverletzung über ein npm-Paket liefe und deshalb heute lautlos
  // durchginge. Zwei getrennte Regel-Kanäle sind bewusst gewählt:
  // `@typescript-eslint/no-restricted-imports` (H1 Schichten, H3 schema/) und
  // das Vanilla-`no-restricted-imports` (H4, ganz src/). Weil Flat-Config bei
  // gleichem Regelnamen die Optionen NICHT mischt, sondern der letzte Treffer
  // gewinnt, dürfen sich zwei Blöcke desselben Kanals in der Dateimenge nicht
  // überlappen: H1 ({core,preview,sandbox,agent,services}) und H3 (schema) sind
  // disjunkt, teilen sich also gefahrlos den ts-Kanal; H4 liegt allein auf dem
  // Vanilla-Kanal.
  //
  // H1 (M3) — core & untere Schichten dürfen die Präsentationstechnik GraphQL
  // nicht kennen. Die Basisschicht erbte einst `DomainError extends
  // GraphQLError`; das hängte das `graphql`-Paket an jeden Wurf in
  // core/services/sandbox. NUR schema/ und http/ dürfen graphql/yoga/pothos
  // kennen. Tests sind ausgenommen: core/__tests__/errors.test.ts importiert
  // GraphQLError bewusst, um zu BEWEISEN, dass DomainError NICHT mehr davon
  // erbt — ein legitimer Assertions-Import, kein Produktions-Leak.
  {
    files: ['apps/server/src/{core,preview,sandbox,agent,services}/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          // patterns-GRUPPE, nicht exakte paths-Namen: ein `name: 'graphql'`
          // fängt nur den exakten String, aber `graphql/error` exportiert
          // GraphQLError genauso — der Sub-Pfad rekonstruierte die M3-Sünde am
          // Gate vorbei. Die Gruppe deckt Paket UND alle Sub-Pfade ab (wie
          // @pothos/* es ohnehin schon tat).
          patterns: [
            {
              group: ['graphql', 'graphql/*', 'graphql-yoga', 'graphql-yoga/*', '@pothos/*'],
              message:
                'M3: Präsentationstechnik (GraphQL/Yoga/Pothos) gehört nur in schema/ und http/. Die Basisschichten müssen graphql-frei bleiben (DomainError darf nie wieder GraphQLError erben).',
            },
          ],
        },
      ],
    },
  },
  // H3 (M1) — kein ausführbarer DB-Zugriff im Transport. Die Kante schema→db
  // ist bewusst erlaubt (Resolver brauchen die Row-TYPEN: Db, UserRow,
  // ChatMessageRow), drizzle ist npm — beides für boundaries unsichtbar. Damit
  // ließe sich die alte touchProject-Sünde (`db.update(projects)` direkt im
  // Resolver) zurückbauen. `allowTypeImports: true` hält die Typen frei, ein
  // WERT-Import aus db/ oder aus drizzle-orm bricht. Tests ausgenommen:
  // chatEventsViewer.test.ts importiert `projects` als Wert, um Testzeilen zu
  // seed­en — legitim, das test-Element hat laut boundaries-Matrix Vollzugriff.
  {
    files: ['apps/server/src/schema/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // patterns-GRUPPE statt exaktem `name: 'drizzle-orm'`: der Sub-Pfad
              // `drizzle-orm/sql` exportiert eq/and/sql und ließe im Resolver ein
              // `ctx.db.run(sql\`update …\`)` zu — genau die M1-Sünde am Gate vorbei.
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
          ],
        },
      ],
    },
  },
  // H2 (M6) — Env-Reads nur in config.ts. config.ts ist die EINZIGE Quelle der
  // Konfiguration; ein verstreuter `Bun.env.X`/`process.env.X` in
  // services/http/schema/… umginge die zentrale Validierung. Greift auf jeden
  // `Bun.env`/`process.env`-Zugriff (auch `Bun.env['X']` und Destructuring
  // `const {X} = Bun.env`, da beides den Member-Zugriff `Bun.env` auslöst).
  // Grenze der Regel: ein Alias des GLOBALS selbst (`const e = Bun; e.env.X`)
  // oder der Umweg über `globalThis.Bun.env`/`globalThis.process.env` entkäme
  // ihr — in der Praxis vernachlässigbar und über den Review gedeckt.
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
  // H2-Ausnahmen: hier IST der Env-Read legitim, die Regel wird abgeschaltet.
  {
    files: [
      // Die eine Quelle der Konfiguration.
      'apps/server/src/config.ts',
      // Der Agent-Daemon läuft IN der VM — Env ist dort der Host→VM-Transport
      // (Gateway-URL, cwd, Ports), kein Host-Konfig-Read.
      'apps/server/src/agent/daemon/**',
      // gitService und processProvider spreaden nur `...process.env` an
      // Kindprozesse (git bzw. Dev-Server) — sie LESEN keine einzelne Variable.
      'apps/server/src/core/gitService.ts',
      'apps/server/src/sandbox/processProvider.ts',
      // Tests setzen/lesen Env bewusst, um genau das Parsing von config.ts zu
      // treiben (config.test.ts) oder Kindprozess-Env zu prüfen (exec/baseline/
      // msb-Tests). Das test-Element hat laut boundaries-Matrix ohnehin
      // Vollzugriff; der M6-Schutz gilt strikt für allen Nicht-Test-Code.
      'apps/server/src/**/__tests__/**',
    ],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  // H4 — src darf nicht aus dem Top-Level-`scripts/` importieren. scripts ist
  // kein boundaries-Element (liegt außerhalb src/), also sähe das Gate einen
  // solchen Import nicht. Vanilla-`no-restricted-imports` (eigener Kanal, s.
  // oben). Tests ausgenommen: config.test.ts importiert bewusst
  // scripts/lib/ports.ts, um die Port-Defaults gegen config abzugleichen
  // (M6-Drift-Schutz) — ein gewollter Cross-Workspace-Import.
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/scripts/**'],
              message:
                'src/ darf nicht aus dem Top-Level-scripts/ importieren (Composition-Root-artige Skripte, keine Schicht). Gemeinsamen Code nach packages/shared ziehen.',
            },
          ],
        },
      ],
    },
  },
);
