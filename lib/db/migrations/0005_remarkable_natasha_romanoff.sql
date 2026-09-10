CREATE TABLE `recipient_confirmations` (
	`token_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`epc` text NOT NULL,
	`channel_fingerprint` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`answered_at` text,
	`answer` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipient_confirmations_event_uidx` ON `recipient_confirmations` (`event_id`);--> statement-breakpoint
CREATE INDEX `recipient_confirmations_expiry_idx` ON `recipient_confirmations` (`expires_at`);