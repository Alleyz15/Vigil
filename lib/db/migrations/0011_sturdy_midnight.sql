DROP INDEX `evidence_event_round_uidx`;--> statement-breakpoint
ALTER TABLE `evidence_requests` ADD `workflow_id` text DEFAULT 'legacy-unbound' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_event_round_uidx` ON `evidence_requests` (`event_id`,`workflow_id`,`sequence`);