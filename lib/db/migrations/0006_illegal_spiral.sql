CREATE TABLE `location_corrections` (
	`correction_id` text PRIMARY KEY NOT NULL,
	`shipment_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`from_snapshot_id` text NOT NULL,
	`to_snapshot_id` text NOT NULL,
	`corrected_at` text NOT NULL,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`shipment_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_snapshot_id`) REFERENCES `location_snapshots`(`snapshot_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_snapshot_id`) REFERENCES `location_snapshots`(`snapshot_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_corrections_sequence_uidx` ON `location_corrections` (`shipment_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `location_snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`shipment_id` text NOT NULL,
	`purpose` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`address_claim` text NOT NULL,
	`source` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`boundary_version` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `location_snapshots_shipment_idx` ON `location_snapshots` (`shipment_id`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`shipment_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`origin_snapshot_id` text NOT NULL,
	`reference_snapshot_id` text NOT NULL,
	`origin_depot` text NOT NULL,
	`destination_depot` text NOT NULL,
	`local` integer NOT NULL,
	`declared_value_sen` integer NOT NULL,
	`cod_amount_sen` integer NOT NULL,
	`recipient_channel` text NOT NULL,
	`recipient_name` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`origin_snapshot_id`) REFERENCES `location_snapshots`(`snapshot_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reference_snapshot_id`) REFERENCES `location_snapshots`(`snapshot_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_idempotency_key_uidx` ON `shipments` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_origin_snapshot_uidx` ON `shipments` (`origin_snapshot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_reference_snapshot_uidx` ON `shipments` (`reference_snapshot_id`);--> statement-breakpoint
-- APPEND-ONLY, enforced here rather than promised in application code.
-- Hand-written below the generated DDL: drizzle-kit does not model triggers.
CREATE TRIGGER `location_snapshots_no_update` BEFORE UPDATE ON `location_snapshots` BEGIN SELECT RAISE(ABORT, 'location_snapshots is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `location_snapshots_no_delete` BEFORE DELETE ON `location_snapshots` BEGIN SELECT RAISE(ABORT, 'location_snapshots is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `shipments_no_update` BEFORE UPDATE ON `shipments` BEGIN SELECT RAISE(ABORT, 'shipments is append-only: the original delivery reference is never overwritten'); END;--> statement-breakpoint
CREATE TRIGGER `shipments_no_delete` BEFORE DELETE ON `shipments` BEGIN SELECT RAISE(ABORT, 'shipments is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `location_corrections_no_update` BEFORE UPDATE ON `location_corrections` BEGIN SELECT RAISE(ABORT, 'location_corrections is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `location_corrections_no_delete` BEFORE DELETE ON `location_corrections` BEGIN SELECT RAISE(ABORT, 'location_corrections is append-only'); END;
