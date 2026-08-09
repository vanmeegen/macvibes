# Homebrew-Formel für macvibes (Installer-Plan, Phase 1).
#
# Diese Datei liegt im Repo, damit sie versioniert und reviewbar ist. Zum
# Ausliefern gehört sie in einen eigenen Tap — üblich ist ein Repo namens
# `homebrew-macvibes` beim selben Owner:
#
#   vanmeegen/homebrew-macvibes/Formula/macvibes.rb
#
# Nutzer installieren dann:
#   brew tap vanmeegen/macvibes
#   brew install macvibes
#   macvibes setup
#
# Warum Homebrew statt DMG (siehe docs/installer-plan.md): Der schwierige Teil
# sind nicht die App-Dateien, sondern die Voraussetzungen — Bun in der richtigen
# Version, git und vor allem microsandbox samt Hypervisor. Genau das löst ein
# Paketmanager als Abhängigkeitsgraph, ohne Signing-/Notarization-Kosten.
class Macvibes < Formula
  desc "Lokale Vibe-Coding-Plattform: Claude-Code-Sessions in MicroVMs"
  homepage "https://github.com/vanmeegen/macvibes"
  url "https://github.com/vanmeegen/macvibes/archive/refs/tags/v0.9.0.tar.gz"
  sha256 "743599a095e4df54207f018c8344d4db1d3e854552ce92e9decfbedcf92a76d1"
  license "MIT"
  head "https://github.com/vanmeegen/macvibes.git", branch: "main"

  # libkrun/HVF gibt es nur auf Apple Silicon; auf Intel liefe nur der
  # Prozess-Modus. Lieber ehrlich ablehnen als eine halbe Installation.
  depends_on arch: :arm64
  # Bun ist die Laufzeit für alles (Server, Web-Build, Skripte). ACHTUNG: macvibes
  # ist auf 1.3.14 gepinnt (CLAUDE.md) — Homebrew liefert die jeweils neueste.
  # Zum Zeitpunkt dieser Formel deckt sich beides; driftet es, meldet
  # `macvibes doctor` die Abweichung als Warnung.
  depends_on "bun"
  # Projekt-Branches im Bare-Repo, Auto-Commit, GitHub-Mirror.
  depends_on "git"
  depends_on :macos

  # microsandbox (msb) ist BEWUSST KEINE brew-Abhängigkeit, obwohl es der
  # Produktzweck ist:
  #   • Upstream liefert einen eigenen Installer (~/.microsandbox/bin/msb) und
  #     empfiehlt ihn — eine brew-Kopie daneben kollidiert mit dessen Symlink
  #     in /opt/homebrew/bin (im echten Install-Test aufgefallen).
  #   • Der brew-Tap ist ein FREMDER Tap; als Abhängigkeit zwänge er jeden
  #     Nutzer zu `brew trust`, nur um macvibes zu installieren.
  #   • macvibes läuft auch ohne: `macvibes setup` richtet dann den
  #     Prozess-Modus ein (ohne Isolat), statt zu scheitern.
  # Geprüft wird es dort, wo es hingehört — zur Laufzeit von `macvibes doctor`.

  def install
    # Den kompletten Quellbaum nach libexec: macvibes läuft als Bun-TS-Source,
    # und die Laufzeitpfade (templates/, apps/web/dist, local-router/run.ts,
    # agent/daemon/main.ts) werden relativ über import.meta.url aufgelöst — der
    # Baum muss deshalb intakt bleiben. Genau deswegen braucht dieser Weg KEINE
    # Pfad-Entkopplung (die wäre nur für eine kompilierte Single-Binary nötig).
    libexec.install Dir["*"]

    # Abhängigkeiten und Web-Build zur INSTALLATIONSZEIT, damit der erste Start
    # schnell ist und zur Laufzeit kein Netz braucht. (In einem eigenen Tap
    # akzeptabel; homebrew-core verböte Netzwerkzugriff im install-Block.)
    cd libexec do
      system formula_opt_bin("bun")/"bun", "install", "--frozen-lockfile"
      system formula_opt_bin("bun")/"bun", "run", "build:web"
    end

    # Ein schlanker Wrapper: die CLI leitet Unterbefehle an die Skripte weiter
    # und leitet ihr Repo-Root aus import.meta.url ab — sie funktioniert daher
    # aus jedem Arbeitsverzeichnis.
    (bin/"macvibes").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("bun")}/bun" "#{libexec}/scripts/cli.ts" "$@"
    SH
    chmod 0755, bin/"macvibes"
  end

  def caveats
    <<~EOS
      Für echte VM-Isolation zusätzlich microsandbox installieren (falls noch
      nicht vorhanden) — entweder mit dem Installer von microsandbox.dev oder:
        brew tap superradcompany/tap && brew trust superradcompany/tap
        brew install superradcompany/tap/microsandbox
      `macvibes doctor` sagt dir, ob es gefunden wurde.

      Erster Schritt — geführtes Setup (Anbieter, Admin, .env, Baselines):
        macvibes setup

      Danach:
        macvibes start     Server starten (LAN, http://<host>.local:4000)
        macvibes doctor    Umgebung prüfen
        macvibes stop      alles beenden

      Voraussetzungen, die das Setup prüft:
        • Ein Anthropic-Zugang (claude setup-token oder API-Key) — ohne ihn
          laufen nur lokale Modelle.
        • microsandbox + Hypervisor für echte VM-Isolation. Fehlt msb, richtet
          das Setup den Prozess-Modus ein (OHNE Isolation, nur für Dev).
        • Die Template-Baselines baut das Setup einmalig; das braucht msb.

      Daten liegen unter ~/macvibes (SQLite-DB, Bare-Repo, Projekt-Volumes).
      Ein `brew uninstall` löscht sie NICHT.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/macvibes --version")
    # doctor endet mit 1, wenn ein harter Blocker fehlt (bun/git) — in der
    # Testumgebung sind beide da, belegte Ports sind nur eine Warnung.
    system bin/"macvibes", "doctor"
  end
end
