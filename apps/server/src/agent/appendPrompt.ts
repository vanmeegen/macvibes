/**
 * Eingebaute Zusatz-System-Anweisung an das Modell — EINE Quelle für den
 * VM-Daemon (Produktivpfad) und den Host-Runner (Dev), damit sich beide Pfade
 * gleich verhalten. Bewusst importfrei: die Datei wird ins VM-Bundle gebündelt
 * (s. agent/daemon/__tests__/bundleGrenze.test.ts).
 *
 * Nötig für schwächere lokale Modelle, die sonst (a) Arbeit nur ankündigen
 * statt Tools aufzurufen und (b) Dateien außerhalb des Projekts schreiben —
 * beides macht die Live-Preview „tot". Für Claude-Modelle ist die Anweisung
 * ein harmloses No-Op. Übersteuerbar per MACVIBES_AGENT_APPEND_PROMPT
 * (config.agent.appendSystemPrompt).
 */
export function defaultAppendSystemPrompt(cwd: string): string {
  return (
    `WICHTIG (macvibes-Laufzeitumgebung): Das Projekt liegt im aktuellen ` +
    `Arbeitsverzeichnis ${cwd}. Erstelle und bearbeite ALLE Dateien ausschließlich ` +
    `dort mit RELATIVEN Pfaden. Verwende NIEMALS absolute Pfade wie /home/user/... ` +
    `oder /root/... — Dateien außerhalb von ${cwd} sind für die Live-Preview unsichtbar. ` +
    `Lies zuerst AGENTS.md im Projekt und HALTE DICH DARAN (welche Datei die App-Wurzel ` +
    `ist, was ausgeliefert wird). Beende deinen Turn NIEMALS mit einer Ankündigung wie ` +
    `"Jetzt mache ich X" oder "Als Nächstes …" — führe angekündigte Schritte SOFORT im ` +
    `selben Turn aus und arbeite die Aufgabe vollständig ab, bevor du zusammenfasst.`
  );
}
