# oMLX statt LiteLLM+Ollama für die lokalen Qwen-Modelle (Plan, Stand 2026-09-11)

> Ergebnis der Analyse „läuft macvibes mit dem Claude Agent SDK gut gegen das
> neue lokale Setup (oMLX + Qwen3.8-27B + Lightning MTP), oder braucht es einen
> anderen Coding-Agenten?" — Antwort: **SDK behalten, Agent NICHT anfassen.**
> Der Claude-Pfad (Claude Code + Claude-Modelle) bleibt der Standard.
>
> **Umgesetzt am 2026-09-11 (Abschnitt A, als Code statt nur Konfiguration):**
> Katalogeintrag `Qwen3.8-27B-oQ4e-mtp` in `agentModel.ts`, lokaler
> Default-Upstream = oMLX (`config.ts`, Probe `/health`, Autostart `omlx serve`),
> LiteLLM bleibt als optionale Bridge für OpenAI-kompatible Anbieter (startet nur
> mit `~/macvibes/litellm.yaml`), Qwen ist auch über die Bridge erreichbar.
> Abschnitt B (Env-Feintuning im Agenten-Pfad) ist bewusst NICHT umgesetzt.
> Referenz-Setup: `../mac-local-coding-agent` (PR #5).

## Warum der Wechsel

|                                     | heute (LiteLLM-Shim → Ollama 0.30.8 gepinnt)                               | oMLX 0.6.4                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Anthropic-`/v1/messages`            | via LiteLLM-Übersetzer (Python-venv, eigener Prozess, `drop_params`)       | **nativ**, inkl. Streaming, Tool-Use, adaptive thinking                             |
| Prompt-Cache bei 20–40k-Token-Turns | nur mit dem 0.30.8-Pin (0.32+ re-prefillt komplett, s. `ollama-update.md`) | Block-Prefix-Cache RAM+SSD, Copy-on-Write, überlebt Neustarts                       |
| Decode-Tempo Qwen 27B (M5 Pro)      | ~15 tok/s (GGUF, MTP nur teilweise)                                        | Lightning MTP (depth-k, verlustfrei) — siehe Messung unten                          |
| Modell                              | Qwen3.6-27B (Tool-Calls brauchten gepatchtes Chat-Template)                | **Qwen3.8-27B** (Aug 2026): deutlich robustere Tool-Calls, Thinking darf an bleiben |
| Betrieb                             | `~/macvibes/bin/ollama` manuell, kein Autostart, CLI/Server-Versionsfalle  | `brew services` / Menüleisten-App, Admin-UI `:8000/admin`                           |

Die Claude-Code-Integration von oMLX (`omlx launch claude`) setzt genau die
Env, die auch unser Daemon braucht — das ist der Beleg, dass der SDK-Pfad
(= Claude Code) gegen oMLX als „supported path" gilt.

## Bleibt das Claude Agent SDK die richtige Harness?

Ja, aus drei Gründen:

1. **Es funktioniert messbar mit Qwen.** Raschkas Vergleich (Juni 2026) fuhr
   Qwen3.6-35B-A3B durch Qwen-Code, Codex und Claude Code: 4/5, 5/5, 5/5
   gelöste Agent-Aufgaben — Claude Code war _nicht_ schlechter, nur
   token-hungriger (ca. 2–3x Input-Tokens pro Session). Qwen3.8-27B wurde von
   Alibaba selbst **mit der Claude-Code-Harness** evaluiert (DeepSWE,
   QwenSWEBench, temp 1.0, 256K).
2. **Der Token-Hunger ist ein Prefill-Problem — und das löst der Cache.** Der
   große System-Prompt + ~20 Tool-Schemata werden pro Session einmal
   prefillt; danach trifft jeder Turn den Prefix-Cache. Genau das fehlte mit
   Ollama ≥0.32 (jeder Turn 2–3 min TTFT).
3. **Ein Harness-Wechsel wäre ein Rewrite** (Daemon, Streaming-Events,
   Resume, Interrupt, Preview-Status hängen alle an `query()`), für einen
   Gewinn, der sich mit drei Env-Variablen weitgehend einholen lässt.

OpenCode/Pi wären nur dann interessant, wenn der System-Prompt-Overhead pro
Turn _ohne_ Cache bezahlt werden müsste. Pi (<1k Token Prompt, 4 Tools) ist die
schnellste Harness pro Turn — als Alternative für „Speed-Modus" denkbar, aber
nicht als Ersatz.

## Konkrete Änderungen

### A) Konfiguration (keine Codeänderung, sofort machbar)

1. oMLX per `../mac-local-coding-agent/setup.sh` aufsetzen (Modell
   `Qwen3.8-27B-oQ4e-mtp`, gepinnt, 128K, MTP an).
2. Modell im Dropdown anlegen — `~/macvibes/models.json`:
   ```json
   [{ "id": "Qwen3.8-27B-oQ4e-mtp", "label": "Qwen 3.8 27B (lokal, oMLX)", "slow": true }]
   ```
3. Direkte Anthropic-Route (matcht VOR dem LiteLLM-Catch-all) in `apps/server/.env`:
   ```
   MACVIBES_MODEL_ROUTES=[{"prefix":"Qwen3.8-","upstreamUrl":"http://localhost:8000","apiKey":"local"}]
   ```
   Der Proxy hängt `/v1/messages` an → `http://localhost:8000/v1/messages`.
   `count_tokens` ruft der Agent laut Shim-Log nie auf (464× `/v1/messages`,
   0× `count_tokens`); oMLX bedient den Pfad trotzdem.
4. LiteLLM-Shim + Ollama-Pin können danach weg (oder als Fallback bleiben —
   die Route greift nur für das neue Präfix).

### B) Später, optional: Feintuning für lokale Modelle (NICHT umgesetzt)

Nur falls der lokale Eintrag später öfter genutzt wird. Wenn, dann strikt an
`slow: true` gebunden, damit der Claude-Pfad unverändert bleibt. Kandidaten
(alles Variablen, die oMLX' eigene Claude-Code-Integration ebenfalls setzt):

| Variable                                                             | Wert               | Warum                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_ATTRIBUTION_HEADER`                                     | `0`                | Claude Code stellt einen pro Request variierenden Attribution-Block an den Prompt-Anfang → zerstört den Prefix-Cache (in `ollama-update.md` schon als offen notiert). |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `131072`           | Für Nicht-`claude-*`-IDs kennt Claude Code das Kontextfenster nicht; ohne diese Werte feuert Auto-Compact zu früh/spät.                                               |
| `API_TIMEOUT_MS`                                                     | `3000000`          | Kaltstart (Modell-Load 10–20 s) + langer Prefill dürfen den SDK-HTTP-Timeout nicht reißen; unsere Turn-Timeouts (SLOW-Werte) bleiben die eigentliche Grenze.          |
| `CLAUDE_CODE_SUBAGENT_MODEL`                                         | `<lokales Modell>` | Sonst gehen Subagent-Aufrufe an `claude-haiku-*` → Anthropic-API (kostet Cloud, mischt Modelle). Optional, falls lokal 100 % gewollt.                                 |

Optional in `daemon/main.ts` per Modellklasse: `disallowedTools` für Tools,
die lokal nur Prompt-Tokens kosten (`WebSearch`, `WebFetch`, `NotebookEdit`,
`Task`), um das Tool-Schema zu verkleinern — erst messen (Prefill ist mit
Cache nur beim ersten Turn teuer).

### C) Was NICHT nötig ist

- Keine Temperatur-Absenkung (Qwen3.8: 1.0/0.95/top_k 20 — niedriger senkt die
  MTP-Akzeptanz und bringt keine stabileren Tool-Calls).
- Kein gepatchtes Chat-Template mehr (`qwen3.6-coder-fixed` war ein 3.6-Problem).
- Kein `preserve_mid_system_cache`-Sonderfall im Code — steht in
  `~/.omlx/settings.json` (setup.sh).

## Verifikation

<!-- MESSUNG:START -->

Gemessen am 2026-09-11 auf dem M5 Pro 48 GB, oMLX 0.6.4, `Qwen3.8-27B-oQ4e-mtp`:

- **Anthropic `/v1/messages`, streaming, mit Tools** (curl, wie der Proxy es
  schickt, inkl. `anthropic-beta: claude-code-…`): `thinking_delta`-Events,
  ein sauberer `tool_use`-Block (`Read`), `stop_reason: tool_use`. ✓
- **`claude -p` mit oMLX-Env** (= Agent-SDK-Pfad, gleiche Harness wie der
  Daemon), Aufgabe „hello.ts anlegen": 2 Turns, 61 s gesamt, Datei korrekt.
  Turn 1: 23,4k Prompt-Tokens kalt (≈57 s), Turn 2: `cache_read_input_tokens:
22528` (≈4 s). Der Prefix-Cache greift also genau dort, wo Ollama ≥0.32
  versagte. ✓
- Rohtempo: Prefill 458 tok/s kalt, Cache-Hit 0,5 s statt 18 s; Decode 31 tok/s
  (16,5 ohne MTP). Zum Vergleich OpenCode auf derselben Aufgabe: 31 s (7,5k
  Prompt-Tokens statt 23k) — schneller, aber kein Grund, die Harness zu wechseln.

<!-- MESSUNG:END -->

Reihenfolge wie in `ollama-update.md` beschrieben: Cache-Smoke-Test (zweimal
derselbe >20k-Prompt, zweiter Request muss den Cache treffen) → 4-Turn-Serie
über macvibes/microsandbox mit Tool-Calls, `bun run typecheck` grün, keine 502
im Server-Log.
