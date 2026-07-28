-- F-Zusatz (AP7): Session-Tokens werden ab jetzt als SHA-256 gespeichert, der
-- Klartext verlässt den Prozess nur noch im Cookie. Bestehende Zeilen lassen
-- sich nicht umrechnen (der Klartext ist ja gerade der Schlüssel), deshalb
-- werden sie verworfen — alle Nutzer müssen sich einmal neu anmelden. Bei der
-- 3-Tage-TTL ist das vertretbar, und faktisch war ohnehin nur eine einzige
-- Sitzung gültig; die übrigen 25 waren abgelaufene Karteileichen, weil sie
-- bisher nur beim Zugriff aufgeräumt wurden.
DELETE FROM sessions;
