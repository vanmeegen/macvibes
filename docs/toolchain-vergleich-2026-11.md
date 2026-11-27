# Toolchain-Vergleich: Ist-Zustand, Bun-Bordmittel, Vite+ (2026-11-27)

Frage: Lässt sich Build, Test, Typecheck, Lint und Format durch Vite+ oder durch
neuere Bun-Bordmittel schneller und schlanker machen?

Gemessen auf einem Apple M5 Pro (18 Kerne), Bun 1.4.5, Node 24.16, im warmen
Zustand, Median aus 3–5 Läufen. Helfer: `docs/toolchain-bench/bench.ts`.
Projektgröße: rund 350 formatierte Dateien, 938 Server-Tests, 218 Web-Tests.

## Ergebnis in Kürze

- Die Werkzeuge sind nicht der Engpass. Format, Lint, Typecheck, Build und
  Web-Tests brauchen zusammen rund 4 s; die Server-Tests allein 48–56 s.
- Der mit Abstand größte Hebel ist `bun test --parallel` für die Server-Tests:
  9,4 s statt 48–56 s, sechsmal hintereinander grün, auch mit den echten
  VM-Tests.
- `bun fmt` ersetzt Prettier ohne eine einzige Formatänderung (0,01 s statt 1,5 s).
- Vite+ bringt hier keinen messbaren Vorteil: Es bündelt dieselben Werkzeuge,
  die schon im Einsatz sind (oxlint, Vitest 5, Vite 8 mit Rolldown).
- Empfehlung: Variante B (Bun-Bordmittel, oxlint und Vite/Vitest bleiben).

## Varianten

| Variante           | Format           | Lint               | Typecheck         | Server-Tests          | Web-Tests          | Web-Build         |
| ------------------ | ---------------- | ------------------ | ----------------- | --------------------- | ------------------ | ----------------- |
| A – Ist            | Prettier         | oxlint             | tsc 7             | `bun test`            | Vitest             | Vite              |
| B – Bun-Bordmittel | `bun fmt`        | oxlint             | `bun check`       | `bun test --parallel` | Vitest             | Vite              |
| C – Vite+          | `vp fmt` (oxfmt) | `vp lint` (oxlint) | `vp check` (tsrs) | `bun test --parallel` | `vp test` (Vitest) | `vp build` (Vite) |

Bun hat in 1.4.5 keinen Linter (`bun lint` gibt es nicht) und keine
DOM-Umgebung für Tests. Vite+ kann die Server-Tests nicht ausführen, weil sie
`bun:test` und `bun:sqlite` benutzen. Eine reine Ein-Werkzeug-Lösung gibt es
für dieses Projekt deshalb in keiner Richtung.

## Messwerte

| Schritt                                         | A – Ist    | B – Bun                | C – Vite+                                           |
| ----------------------------------------------- | ---------- | ---------------------- | --------------------------------------------------- |
| Format prüfen                                   | 1,51 s     | 0,01 s                 | 0,13 s                                              |
| Lint (mit Architektur-Grenzregel)               | 0,40 s     | 0,40 s                 | 0,50 s                                              |
| Typecheck, alle vier Projekte                   | 0,41 s     | 0,26 s                 | ca. 0,2 s (tsrs einzeln: Server 0,09 s, Web 0,10 s) |
| Web-Build                                       | 0,18 s     | 0,18 s (Vite bleibt)   | 0,21 s                                              |
| Web-Tests (218)                                 | 1,10 s     | 1,10 s (Vitest bleibt) | 1,15 s                                              |
| Server-Tests (938), ohne VM-Tests               | 48,5 s     | 9,3 s                  | 9,3 s                                               |
| Server-Tests (938), mit VM-Tests                | 55,7 s     | 9,4 s                  | 9,4 s                                               |
| **CI gesamt, nacheinander**                     | **52,4 s** | **11,2 s**             | **11,3 s**                                          |
| CI gesamt, alle Schritte gleichzeitig gestartet | –          | 9,7 s                  | nicht gemessen                                      |

`vp check` (Format, Lint und Typen in einem Aufruf) lief mit Projektregeln in
0,59 s für Lint und Typen zusammen.

### Dependency-Analyse

| Werkzeug                 | Zeit   | Liefert                                                                 |
| ------------------------ | ------ | ----------------------------------------------------------------------- |
| `bun audit`              | 0,29 s | bekannte Schwachstellen                                                 |
| `bun outdated`           | –      | veraltete Pakete (aktuell nur `eslint-plugin-boundaries` 7.4.4 → 7.4.5) |
| knip 6.48                | 0,44 s | ungenutzte Dateien, Abhängigkeiten und Exporte                          |
| oxlint `import/no-cycle` | 0,44 s | Importzyklen (aktuell keine)                                            |

Vite+ bringt für Dependency-Analyse nichts Eigenes mit. knip meldet ohne
Konfiguration 17 ungenutzte exportierte Typen und viele Fehlalarme in
`templates/`; brauchbar wird es erst mit einer Ignore-Liste.

**Nebenbefund:** `bun audit` meldet auf `main` 50 Schwachstellen (1 kritisch,
14 hoch, 31 mittel, 4 niedrig), darunter `proxy-addr` (kritisch) und `zod`
< 4.6.6 (hoch). Das ist unabhängig von dieser Untersuchung und nicht weiter
analysiert.

## Was nicht lohnt

- **Web-Build mit `bun build`:** 44 ms statt 98 ms reine Bündelzeit, aber das
  JS-Bundle wird 1,0 MB statt 679 KB, und die Schriften landen als Daten-URLs
  im CSS (0,92 MB statt 37 KB). Dazu müsste der Dev-Server samt GraphQL-Proxy
  und `fs.deny`-Härtung neu gebaut werden.
- **Web-Tests mit `bun test`:** Unportiert laufen 62 von 218 Tests; 10 von 16
  Dateien laden nicht, weil `vi.stubGlobal`, `vi.unstubAllGlobals` und
  `vi.mocked` fehlen. jsdom müsste über ein eigenes Preload eingehängt werden.
  Erreichbarer Gewinn: weniger als eine Sekunde.
- **Vite+ insgesamt:** `vp migrate` lief sauber durch (18 Testdateien
  umgeschrieben, Skripte auf `vp` umgestellt), aber:
  - 42 zusätzliche Pakete, dazu `catalog` und `overrides` in der
    Root-`package.json`; Vite wird durch einen Alias auf
    `@voidzero-dev/vite-plus-core` ersetzt.
  - oxfmt formatiert 20 Dateien anders als Prettier (vor allem `package.json`
    und CSS), also einmaliges Umformatieren.
  - Die Lint-Regeln müssten aus `oxlint.config.ts` in `vite.config.ts`
    umziehen; `vp lint` liest die bestehende Datei nicht.
  - Der Typecheck läuft über `tsrs` 7.1.0-beta und prüft auch Dateien
    außerhalb der tsconfigs (5 Fehlmeldungen in `docs/`).
  - Die Migration hat auch `templates/fullstack` angefasst; das sind die
    Vorlagen für Nutzerprojekte und müssten ausgenommen werden.
  - Vite+ pinnt oxlint 1.94 statt unserer 1.95; Updates der Einzelwerkzeuge
    hängen dann am Vite+-Release.

## Empfehlung: Variante B

1. `apps/server`: `"test": "bun test --parallel"`. Spart rund 45 s je CI-Lauf.
2. Prettier durch `bun fmt` ersetzen (`format`, `format:check`, lint-staged).
   `bun fmt` liest die vorhandene `.prettierrc`; damit entfällt das Paket
   `prettier`.
3. Typecheck auf `bun check` umstellen ist möglich (gleiche Fehler in der
   Gegenprobe, 0,26 s statt 0,41 s), bringt aber nur 0,15 s. `bun check` gibt
   es erst seit 1.4.3; sinnvoll wäre, `tsc` vorerst in der CI zu behalten.
4. oxlint, Vite und Vitest bleiben wie sie sind.

### Offen vor einer Umsetzung

- `bun test --parallel` ist nur auf dem Mac gemessen. Der Windows-Runner der
  CI ist nicht geprüft.
- Auch parallel brauchen die Server-Tests noch 9,4 s; welche Dateien das
  bestimmen, ist nicht untersucht (`--timings` würde es zeigen).
- `bun fmt --staged` als Ersatz für den Prettier-Teil von lint-staged ist
  nicht ausprobiert.
