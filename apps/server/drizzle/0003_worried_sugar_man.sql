ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `approved` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Einmaliger Backfill: bereits registrierte Nutzer NICHT aussperren.
UPDATE `users` SET `approved` = 1;--> statement-breakpoint
-- Ältesten Nutzer (Erst-Registrierung) zum Admin machen.
UPDATE `users` SET `role` = 'admin'
WHERE `id` = (SELECT `id` FROM `users` ORDER BY `created_at` ASC LIMIT 1);