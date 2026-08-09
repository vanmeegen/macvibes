# Installer & First-Run-Setup — Plan

Stand: 2026-08-08. Grundlage: Evaluation der Runtime-/Packaging-Faktenlage
(siehe Inventar in dieser Session). Kernbefund: **Der Installer ist der
einfache Teil — die Voraussetzungen (Hypervisor + nativer msb/libkrun-Stack +
Credentials + Baseline-Bau) sind das Eigentliche.** Kein Installer-Format nimmt
das ab; also gestuft, ehrlich, Mac zuerst.

## Entscheidung

- **Weg: Homebrew (Mac) + geführtes First-Run-Setup + Menüleisten-Launcher.**
  Homebrew löst den harten Teil automatisch als Abhängigkeitsgraph (`bun`
  gepinnt, `microsandbox` via tap, `git`, optional `caddy`). Nahe am
  Doppelklick, ohne die Kosten eines nativen Installers.
- **Zuerst gebaut wird das First-Run-Setup** (`bun run setup` /
  `macvibes setup`). Es ist der wiederverwendbare Kern jeder Variante und
  läuft schon im heutigen Source-Betrieb — unabhängig von der späteren
  Verpackung.

## Bewusst verworfen

- **Native DMG + MSI (Doppelklick-Installer):** zu teuer (Apple-Notarization
  99 $/Jahr + Authenticode-Cert, sonst Gatekeeper-/SmartScreen-Warnungen) und
  gegen das Ziel, **Open Source** zu bleiben. Der wörtliche Doppelklick ist den
  Preis hier nicht wert.
- **Tauri-/Electron-Wrapper:** nicht nötig. Löst den harten Teil (msb/
  Hypervisor) ohnehin nicht und zieht eine ganze Rust-/Sidecar-Schicht ein.
- **`bun build --compile` Single-Binary:** löst nur das Ausliefern des
  App-Codes, nicht den VM-Stack. Nice-to-have, kein Fokus.
- **Windows (Phase 2) vorerst zurückgestellt:** Der VM-Pfad ist dort noch
  Preview/blockiert (msb #1218). Wir warten, bis er verfügbar ist, statt das
  Teuerste zuerst für die Plattform zu bauen, die das Kernfeature noch nicht
  kann. Der Prozess-Provider-Dev-Modus läuft unter Windows bereits (Stufe 1).

## First-Run-Setup — Ablauf & Reihenfolge

Läuft **nach** dem Voll-Install (Deps sind da) beim ersten Start. Leitregel:
**Setup endet immer in einem lauffähigen, nicht ausgesperrten Zustand** — nie
halb konfiguriert.

1. **Doctor** — prüft `bun` (Pin 1.3.14), `git`, `msb` + Hypervisor (HVF auf
   Apple Silicon), freie Ports (4000/4010/4173, Web 5173). Fehlt etwas: klare,
   umsetzbare Meldung (welcher `brew install …`), kein stiller Abbruch.
2. **Modell-Anbieter wählen** (siehe unten) — Claude als Default, optional
   weitere Systeme über LiteLLM.
3. **Admin festlegen** — `MACVIBES_ADMIN_USERNAME` ist **Pflicht**. Ohne
   Bootstrap-Admin kann niemand Nutzer freischalten → das ist die
   „sperr-dich-nicht-selbst-aus"-Absicherung. Der Preflight bricht heute schon
   laut ab, wenn er fehlt; das Setup stellt sicher, dass er gesetzt ist.
4. **`.env` schreiben** (`apps/server/.env`, `chmod 600`) und `~/macvibes`-Baum
   anlegen.
5. **Baselines bauen** (`bun run baselines`) — **braucht laufendes msb**. Das
   ist der heikle Sequenzpunkt: fehlt msb/HVF, gibt es keine bootfähige
   Projekt-VM. Absicherung gegen Aussperren:
   - msb vorhanden → Baselines bauen, voller VM-Modus.
   - msb/HVF fehlt → **Prozess-Modus als klar benannter Fallback**
     (`MACVIBES_SANDBOX=process`, ohne VM-Isolation) statt eines toten
     Zustands, plus Hinweis, wie man auf den vollen Modus nachrüstet.
6. **Start** — Server hoch, Browser öffnen; der Admin registriert sich, wird
   automatisch befördert und schaltet weitere Nutzer frei.

## Modell-Anbieter im Setup (neu)

Das Setup fragt den Anbieter ab statt Claude fest zu verdrahten:

- **Default: Claude (Anthropic).** `CLAUDE_CODE_OAUTH_TOKEN` (via
  `claude setup-token`, für Max/Abo bevorzugt) **oder** `ANTHROPIC_API_KEY`.
- **Optional ankreuzbar: andere KI-Systeme.** Wird es gewählt, fragt das Setup
  nach dem Backend:
  - **Ollama (lokal)** — braucht KEINE Env: der mitgelieferte LiteLLM-Router
    wird in `config.ts` automatisch erkannt und gestartet
    (`detectLocalRouterCommand`), lokale Modelle sind damit ohne Zutun aktiv.
    Nur ein abweichender Router-Befehl setzt `MACVIBES_LOCAL_ROUTER_CMD`.
  - **OpenRouter / OpenAI** — laufen über **denselben** LiteLLM-Router. WARUM
    nicht als `MACVIBES_MODEL_ROUTES`: OpenRouter/OpenAI bieten NUR einen
    OpenAI-kompatiblen Endpunkt, der Credential-Proxy hängt aber den
    Request-Pfad an `upstreamUrl` an und schickt Anthropics `/v1/messages`
    (`anthropicProxy.ts`) — eine rohe Anbieter-URL scheitert am Format-Mismatch.
    Das Setup setzt deshalb **nur den Key** (`OPENROUTER_API_KEY` bzw.
    `OPENAI_API_KEY`); der Router liest ihn per `os.environ` und übersetzt
    Anthropic↔OpenAI. Der Router führt bereits aktive Beispiel-Aliase
    (`litellm_config.yaml`) — verifiziert: LiteLLM startet auch OHNE gesetzten
    Key (der Alias wird erst beim Aufruf gebraucht). Das Setup fasst die YAML
    NICHT an (robuster: statische, versionierte Config; nur die `.env` wird über
    den gehärteten Schreibpfad angefasst) und weist auf die zwei manuellen
    Schritte hin: gewünschtes Modell als `model_name` in `litellm_config.yaml`
    führen und mit demselben Namen in `agentModel.ts` in den Katalog aufnehmen.
  - **Eigener Endpunkt (custom)** — bleibt eine echte Route in
    `MACVIBES_MODEL_ROUTES` (`[{prefix, upstreamUrl, apiKey?}]`). Der Prompt
    stellt klar: der Endpunkt MUSS Anthropics `/v1/messages`-Format sprechen
    (z. B. ein selbst betriebener LiteLLM-Shim).

    Claude und Zusatz-Anbieter schließen sich nicht aus — der Credential-Proxy
    routet pro Request nach dem `model` im Body. „Nur lokal, kein Claude" ist
    ebenfalls erlaubt (dann Warnung statt Abbruch, Fallback lokaler Router).

## Phasen

- **Phase 0 — verpackbar machen** (Fundament, folgt bei Bedarf): `import.meta.url`-
  Pfade hinter Env/execPath, web+Daemon zur Package-Zeit statt Laufzeit, eine
  `macvibes`-CLI (`bin`) mit `setup · start · stop · doctor`, Versionierung +
  Release-Job. Wiederverwendbar für jedes Endformat.
- **Phase 1 — Mac:** Homebrew-Formel/Cask + das First-Run-Setup + eine
  signierte/notarisierte Menüleisten-`.app`, die First-Run übernimmt und den
  Server als launchd-Agent managt.
- **Phase 2 — Windows:** zurückgestellt bis msb-Windows aus dem Preview ist.

## Erster Schritt

Das **geführte First-Run-Setup** (`bun run setup`) — läuft im heutigen
Source-Betrieb, ist der Kern jeder späteren Verpackung, und enthält die
Anbieter-Wahl (Claude default / LiteLLM optional) sowie die Aussperr-
Absicherung aus dem Ablauf oben.
