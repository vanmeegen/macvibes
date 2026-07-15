# Ollama-Update: Warum wir auf 0.30.8 gepinnt sind (Stand 2026-07-15)

## Aktueller Zustand

| Was                         | Stand                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Laufender Ollama-Server** | **0.30.8** — Binary unter `~/macvibes/bin/ollama` (GitHub-Release), manuell per `nohup ~/macvibes/bin/ollama serve` gestartet. **Kein Autostart nach Reboot!**                                          |
| brew-Installation           | 0.32.0 (installiert, aber bewusst NICHT genutzt)                                                                                                                                                        |
| Servierte Modelle           | `qwen3.6-coder-fixed` (Standard, gepatchtes Chat-Template froggeric v21.3), `qwen3.6-moe`                                                                                                               |
| ⚠️ Falle                    | Das `ollama`-CLI im PATH ist die brew-0.32! `ollama create`/`pull` damit schreibt Manifeste, die der 0.30.8-Server als Müll ausliefert. Für Modell-Operationen immer `~/macvibes/bin/ollama` verwenden. |

## Warum nicht 0.32?

Nacht-Testserie 2026-07-15 (4-Turn-Vibe-Coding via macvibes/microsandbox, identisches
Szenario): Mit 0.32.0 lieferte **keine einzige Turn** ein Ergebnis (502/Timeout-Kette),
mit 0.30.8 lief dieselbe Serie durch. Kein Konfigurationsfehler — Ursache verstanden:

1. **0.32 hat die Engine umgebaut**: startet den upstream `llama-server` (llama.cpp)
   direkt. Dessen Prompt-Cache funktioniert mit der Qwen-3.5/3.6-Architektur
   (`qwen35`, Sliding-Window-/Hybrid-Attention) notorisch schlecht: Checkpoints werden
   invalidiert, Log sagt _„forcing full prompt re-processing due to lack of cache data
   (likely due to SWA or hybrid/recurrent memory)"_.
2. **Folge bei Agent-Workloads** (Claude Code schickt pro Request 20–40k Token):
   jeder Request prefillt komplett neu → bei ~212 t/s **2–3 Minuten bis zum ersten
   Token** → reißt die Agent-/Shim-Timeouts → Client bricht ab → Ollama loggt
   „client closing the connection", antwortet 500 → bei uns 502/keine Antwort.
   Messwerte der Nacht: 0.32 `sim_best = 0.288` (Cache-Miss); 0.30.8 `sim_best ≈ 0.99`,
   131 Cache-Treffer vs. 14 große Re-Prefills. Roh-Prefill-Tempo ist gleich
   (~230 vs. ~212 t/s) — es ist NUR der Cache.
3. **0.30.8 hatte genau dafür einen eigenen Fix** („Improved prompt caching by
   decoupling it from context shift for better KV cache reuse", Release 2026-06-12),
   den der 0.32-Engine-Umbau faktisch wieder verliert.
4. **Kein Workaround per Parameter**: die llama.cpp-Flags (`--swa-full`,
   `--ctx-checkpoints`, `--cache-ram`) reicht Ollama nicht durch.

## Upgrade-Check (so prüfen wir, ob eine neuere Version wieder geht)

1. **Upstream-Status prüfen** — sind diese Issues gefixt bzw. erwähnen die
   Ollama-Release-Notes einen Prompt-Cache-/Qwen-Fix?
   - <https://github.com/ggml-org/llama.cpp/issues/22746> (Qwen 3.6 27B full re-processing)
   - <https://github.com/ggml-org/llama.cpp/issues/23013> (dito)
   - <https://github.com/ggml-org/llama.cpp/issues/19858>, <https://github.com/ggml-org/llama.cpp/issues/20225> (Qwen 3.5)
   - <https://github.com/ollama/ollama/releases>
2. **Testkandidat installieren** (brew upgrade), Server MIT DEM NEUEN CLI neu
   aufsetzen — Modelle ggf. mit dem neuen CLI neu erstellen (Manifest-Inkompatibilität,
   siehe Falle oben). Fix-Template-Bauanleitung: Kommentar in
   `apps/server/local-router/litellm_config.yaml`.
3. **Cache-Smoke-Test** (5 Minuten, ohne VM): zweimal denselben langen Prompt
   (>20k Token) an `/api/chat` schicken; im Ollama-Log muss der zweite Request
   `sim_best ≈ 0.99` und einen kleinen Prefill zeigen. Erscheint stattdessen
   „forcing full prompt re-processing" → Version ist weiterhin unbrauchbar, zurück
   zu 0.30.8.
4. **Volltest**: `scratchpad/vibeseries.sh`-artige 4-Turn-Serie (Pomodoro-Szenario)
   gegen ein macvibes-Projekt mit `qwen3.6-coder`; Erfolgskriterium: alle Turns
   mit Tool-Calls und Antwort, `bun run typecheck` grün, keine 502 im Shim-Log
   (`~/macvibes/local-router.log`).
5. **Bei Erfolg**: brew-Version übernehmen, `~/macvibes/bin/ollama`-Sonderweg und
   diesen Pin auflösen, Autostart-Frage klären.

## Verwandte Stellschraube (unabhängig vom Update)

Claude Code sendet am Prompt-Anfang einen **Attribution-Header mit variablen Daten**
(Version, Fingerprint) — der ändert sich pro Request und zerstört den präfixbasierten
Cache zusätzlich (erklärt vermutlich die 16 vollen Re-Prefills, die auch auf 0.30.8
auftraten). Abschaltbar per Env `CLAUDE_CODE_ATTRIBUTION_HEADER=0` im Agent-Daemon
(VM) — noch nicht umgesetzt/gemessen.
Quelle: <https://www.mykolaaleksandrov.dev/posts/2026/06/claude-code-llamacpp-prompt-cache-fix/>

## Rohdaten der Nacht-Testserie

Session-Scratchpad (flüchtig): `overnight-report.txt`, `MORGENREPORT.md`;
Ollama-Logs: `/tmp/ollama-serve.log` (0.32), `/tmp/ollama-0308.log` (0.30.8);
Shim-Log: `~/macvibes/local-router.log`.
