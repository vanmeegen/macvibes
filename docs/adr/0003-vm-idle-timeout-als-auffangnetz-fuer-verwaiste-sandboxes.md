# ADR 0003 — VM-Idle-Timeout als Auffangnetz für verwaiste Sandboxes

**Status:** angenommen · **Datum:** 2026-07-31

## Problem

Stirbt der macvibes-Server (Absturz, `kill -9`, hartes Beenden), laufen seine
MicroVMs weiter. Der neue Prozess kennt sie nicht: Der `SandboxManager` startet
mit leerer Tabelle, also greift weder Grace- noch Idle-Timer. Die VMs belegen
Speicher und CPU, bis jemand sie von Hand stoppt.

Am 2026-07-30 sind auf diese Weise drei VMs zurückgeblieben. Das Shutdown-Skript
meldet solche Waisen inzwischen deutlich, aber es setzt voraus, dass jemand es
ausführt — nach einem Absturz tut das niemand.

microsandbox bietet mit `idleTimeout` ein Mittel, das im Gast selbst greift und
keinen lebenden Host braucht. Die Frage war, ob es sich einsetzen lässt, ohne
laufende Arbeit zu zerstören.

## Was „Aktivität" für microsandbox bedeutet (gemessen)

Die Semantik ist nicht dokumentiert. Deshalb ein Spike gegen microsandbox 0.6.8,
Frist jeweils 25 s, Beobachtung 70 s:

| Reiz alle 10 s                      | Ergebnis               |
| ----------------------------------- | ---------------------- |
| nichts (Grundlinie)                 | gestoppt bei ~30 s     |
| `handle.touch()`                    | **lebt nach 70 s**     |
| HTTP auf den gemappten Preview-Port | gestoppt bei ~30 s     |
| `exec` in der Sandbox               | **lebt nach 70 s**     |
| ausgehender Verkehr aus dem Gast    | gestoppt (siehe unten) |

**Nur vom Host ausgelöste Steuerungs-Aktionen zählen** — `touch()` und `exec`.
Weder eingehender Verkehr auf dem gemappten Port noch ausgehender Verkehr des
Gastes setzt die Frist zurück.

Der Fall „ausgehender Verkehr" war zunächst mehrdeutig: Die VM starb erst bei
~55 s statt ~30 s, was nach teilweiser Anrechnung aussah. Eine Kontrollgruppe
mit identischem Startkommando, aber **ohne** Netzzugriff starb ebenfalls bei
~55 s — der Unterschied kam vom schwereren Hochlauf, nicht vom Verkehr. Ohne
diese Kontrolle wäre eine falsche Semantik dokumentiert worden.

### Warum das genau passt

Beides folgt daraus, und beides ist erwünscht:

- Eine offene Preview hält die VM **nicht** am Leben. Zuschauen allein ist keine
  Aktivität — konsistent damit, dass auch der host-seitige Idle-Timer davon
  nichts weiß.
- Der Agent-Daemon einer verwaisten VM versucht endlos, sich neu zu verbinden.
  Diese Versuche halten sie **nicht** am Leben. Genau deshalb funktioniert das
  Auffangnetz überhaupt.

## Entscheidung

Die VM bekommt eine Idle-Frist von **`idleMs` + 15 Minuten** (Default also
45 min). Kein eigener Konfigurationsparameter: Die Frist leitet sich aus dem
host-seitigen Idle-Timer ab, damit beide nicht auseinanderlaufen können.

Im Normalbetrieb greift immer zuerst macvibes' eigene Logik. Die VM-Frist feuert
ausschließlich, wenn der Host nicht mehr da ist, um sie zurückzusetzen.

`SandboxManager.touch()` — die Stelle, die schon heute den host-seitigen
Idle-Timer zurücksetzt — stößt zusätzlich `touch()` auf der Sandbox an.

### Gedrosselt, sonst Hunderte Aufrufe pro Turn

`noteAgentActivity` feuert bei **jedem** Agent-Event, also bei jedem
Text-Delta. Ein ungedrosselter Durchgriff wäre pro Turn eine dreistellige Zahl
von API-Aufrufen. Der VM-Touch läuft deshalb höchstens alle 60 s.

## Ein laufender Turn wird nie unterbrochen

Das ist die Bedingung, an der die Entscheidung hängt. Sie gilt strukturell, nicht
nur nach Augenmaß:

Die Turn-Schleife im `ChatService` bricht einen Turn selbst ab, wenn länger als
`timeouts.idleMs` kein Agent-Event eintrifft (3 min bei schnellen, **10 min** bei
langsamen Modellen). Jedes Event ruft `onAgentActivity` → `noteAgentActivity` →
`touch`.

Daraus folgt: **Während eines laufenden Turns ist der Abstand zwischen zwei
Touches durch 10 Minuten begrenzt.** Ein größerer Abstand bedeutet, dass macvibes
den Turn ohnehin abgebrochen hat.

|                                         |            |
| --------------------------------------- | ---------- |
| größter Touch-Abstand im laufenden Turn | 10 min     |
| Drosselung des VM-Touch                 | 60 s       |
| VM-Frist                                | 45 min     |
| **Reserve**                             | **35 min** |

Die Frist kann während eines Turns also nicht erreicht werden.

## Verworfene Alternativen

- **Eigener Konfigurationsparameter für die VM-Frist:** zwei Werte, die
  auseinanderlaufen können. Wer `MACVIBES_IDLE_MS` erhöht, müsste daran denken,
  den zweiten mitzuziehen — sonst stoppt die VM-Frist Sandboxes, die
  host-seitig noch als aktiv gelten.
- **`exec` statt `touch` als Lebenszeichen:** funktioniert laut Messung
  ebenfalls, startet aber einen Prozess im Gast, statt nur einen Zähler zu
  setzen.
- **Host-seitiger Wächter, der verwaiste VMs aufräumt:** braucht genau das, was
  im Absturzfall fehlt — einen lebenden Host.
- **Auf `msb run --replace` verlassen:** räumt eine gleichnamige Sandbox beim
  nächsten Start ab (gemessen, siehe Test „Belegter Sandbox-Name"), aber erst
  wenn jemand das Projekt wieder öffnet. Bis dahin läuft die Waise weiter.
