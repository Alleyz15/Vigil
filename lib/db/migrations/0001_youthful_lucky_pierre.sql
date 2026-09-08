CREATE TABLE `disputes` (
	`dispute_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`epc` text NOT NULL,
	`raised_at` text NOT NULL,
	`kind` text DEFAULT 'not_received' NOT NULL,
	`notes` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `disputes_event_uidx` ON `disputes` (`event_id`);--> statement-breakpoint
CREATE INDEX `disputes_raised_idx` ON `disputes` (`raised_at`);--> statement-breakpoint
CREATE TABLE `reference_sites` (
	`site_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`label` text
);
--> statement-breakpoint
CREATE INDEX `reference_sites_kind_idx` ON `reference_sites` (`kind`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_parcels` (
	`epc` text PRIMARY KEY NOT NULL,
	`waybill_no` text NOT NULL,
	`recipient_name` text NOT NULL,
	`recipient_phone` text,
	`recipient_address` text NOT NULL,
	`recipient_lat` real,
	`recipient_lng` real,
	`declared_value_sen` integer DEFAULT 0 NOT NULL,
	`cod_amount_sen` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_parcels`("epc", "waybill_no", "recipient_name", "recipient_phone", "recipient_address", "recipient_lat", "recipient_lng", "declared_value_sen", "cod_amount_sen", "created_at") SELECT "epc", "waybill_no", "recipient_name", "recipient_phone", "recipient_address", "recipient_lat", "recipient_lng", "declared_value_sen", "cod_amount_sen", "created_at" FROM `parcels`;--> statement-breakpoint
DROP TABLE `parcels`;--> statement-breakpoint
ALTER TABLE `__new_parcels` RENAME TO `parcels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `parcels_waybill_idx` ON `parcels` (`waybill_no`);--> statement-breakpoint
ALTER TABLE `verdicts` ADD `basis` text DEFAULT 'both_axes' NOT NULL;