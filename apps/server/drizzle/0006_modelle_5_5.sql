-- Modelle auf die 5.5-Generation: bestehende Projekte wandern von den
-- abgelösten Modellen auf ihre Nachfolger.
--
-- Bewusst NUR Updates. Der Spalten-Default von projects.agent_model bleibt
-- 'claude-sonnet-5': SQLite kann einen Default nur über einen Neubau der
-- Tabelle ändern, und das DROP TABLE dabei löscht über ON DELETE CASCADE alle
-- chat_messages (PRAGMA foreign_keys=OFF wirkt in der Migrations-Transaktion
-- nicht) — auf einer Kopie der Produktionsdaten nachgestellt. Der alte Default
-- wird nie wirksam: der Service setzt das Modell beim Anlegen ausdrücklich, und
-- gelesen wird über effectiveAgentModel (unbekanntes Modell → aktueller Default).
--
-- claude_session_model bleibt unverändert: weicht es vom Projekt-Modell ab,
-- startet der nächste Turn eine frische Session (kein Resume über einen
-- Modellwechsel, s. agent/agentModel.ts).
UPDATE `projects` SET `agent_model` = 'claude-sonnet-5-5' WHERE `agent_model` = 'claude-sonnet-5';--> statement-breakpoint
UPDATE `projects` SET `agent_model` = 'claude-haiku-5-5' WHERE `agent_model` = 'claude-haiku-4-5';--> statement-breakpoint
UPDATE `projects` SET `agent_model` = 'claude-opus-5-5' WHERE `agent_model` = 'claude-opus-4-8';
