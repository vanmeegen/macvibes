---
status: accepted
---

# Preview-Status über den Agent-Daemon-WebSocket statt monit-Port-Mapping

Der Preview-Status wurde über ein Host-Port-Mapping auf die monit-HTTP-API der
VM gepollt (alle 2 s eine frische TCP-Verbindung). Live-Befund 2026-07-16:
microsandbox (0.6.6) verlor das Mapping des monit-Ports, während VM und
Dev-Server einwandfrei weiterliefen — der Status hing dauerhaft auf
`restarting`, das Preview-Overlay kam nie zurück. Der Forwarder pro
`-p`-Mapping ist ein eigener userspace-Task in msb; stirbt er, wird er nicht
neu aufgesetzt. Ausgerechnet der Status-Kanal erzeugt mit dem 2-s-Polling die
meisten kurzlebigen Verbindungen und reizt damit die bekannten
msb-Teardown-Schwächen (vgl. FIN/RST-Härtung des Agent-Transports) am
stärksten.

**Entscheidung:** Der Agent-Daemon liest monit in der VM lokal
(`localhost:2812`, kein Mapping) und pusht `preview-status`-Nachrichten über
seine bestehende, ausgehende WebSocket-Verbindung zum Host-Gateway — die
einzige Richtung, die sich gegen msb-Macken als robust erwiesen hat. Das
monit-Port-Mapping entfällt. Die gesamte Kontrollebene (Turns, Interrupt,
Heartbeat, Status) läuft damit über genau eine Verbindung pro VM.

**Bewusst NICHT über diese Verbindung:** der Preview-Traffic selbst
(Port-Mapping bleibt — Datenebene, HMR-WebSockets, LAN-Erreichbarkeit nach R7)
und der Credential-Proxy (eigener ausgehender Kanal mit SSE-Streaming).

## Konsequenzen

- **Monitoring ist nie wieder Single Point of Failure:** Der Host behandelt
  ausbleibende Pushes (Staleness-Timeout) nicht als Preview-Ausfall, sondern
  fällt auf die HTTP-Probe des Preview-Ports zurück (`statusWithProbeFallback`,
  eingeführt als Sofortmaßnahme beim Live-Befund). Antwortet die Preview, gilt
  `ready` — die Probe ist die Ground Truth für „benutzbar", monit liefert nur
  Detailtiefe (`failed` bei Crash-Loop, `restarting`).
- **Rollenschnitt:** Der Agent-Daemon ist damit offiziell der VM-Agent der
  Plattform (Claude-Runner UND Status-Reporter), nicht mehr nur
  Claude-Transport. Im Gateway-Protokoll ist `preview-status` ein eigener
  Message-Typ, getrennt vom Turn-Streaming.
- **Boot-Semantik unverändert:** Vor dem ersten Daemon-Kontakt bleibt der
  Status `starting`; verbindet sich nie ein Daemon, greifen Timeout/Probe wie
  bisher.
- Push kann ereignisbasiert sein (Statuswechsel + Keepalive) — reaktiver als
  das bisherige 2-s-Polling, und der msb-Bug wird gar nicht mehr gereizt.

## Verworfene Alternativen

- **Nur der Probe-Fallback (Status quo nach Sofortmaßnahme):** heilt das
  Symptom, aber das fragile Mapping und der TCP-Beschuss bleiben; monit-Detail
  (`failed`/`restarting`) geht bei totem Mapping verloren.
- **Preview-Traffic mit durch den Daemon-WS tunneln:** hieße einen kompletten
  HTTP/WS-Proxy im Daemon nachzubauen (HMR, Streaming, Performance) — und das
  0.0.0.0-Mapping braucht es für den LAN-Zugriff ohnehin.
- **msb-Fix abwarten/upstream:** Issue lohnt sich, ist aber außerhalb unserer
  Kontrolle; die Plattform darf nicht von der Bug-Freiheit des Sandboxers
  abhängen.
