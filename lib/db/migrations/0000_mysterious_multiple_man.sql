CREATE TABLE `couriers` (
	`courier_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`public_key` text NOT NULL,
	`bound_device_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`event_time` text NOT NULL,
	`record_time` text NOT NULL,
	`event_time_zone_offset` text NOT NULL,
	`read_point` text,
	`biz_location` text,
	`biz_step` text,
	`disposition` text,
	`courier_id` text,
	`primary_epc` text,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	FOREIGN KEY (`courier_id`) REFERENCES `couriers`(`courier_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_courier_time_idx` ON `events` (`courier_id`,`event_time`);--> statement-breakpoint
CREATE INDEX `events_epc_time_idx` ON `events` (`primary_epc`,`event_time`);--> statement-breakpoint
CREATE TABLE `mandates` (
	`mandate_id` text PRIMARY KEY NOT NULL,
	`courier_id` text NOT NULL,
	`preset` text NOT NULL,
	`scope_json` text NOT NULL,
	`limits_json` text NOT NULL,
	`validity_json` text NOT NULL,
	`requires_cosign_if_json` text NOT NULL,
	`cooldown_seconds` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`nonce_counter` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`courier_id`) REFERENCES `couriers`(`courier_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mandates_courier_idx` ON `mandates` (`courier_id`,`status`);--> statement-breakpoint
CREATE TABLE `parcels` (
	`epc` text PRIMARY KEY NOT NULL,
	`waybill_no` text NOT NULL,
	`recipient_name` text NOT NULL,
	`recipient_phone` text,
	`recipient_address` text NOT NULL,
	`recipient_lat` integer,
	`recipient_lng` integer,
	`declared_value_sen` integer DEFAULT 0 NOT NULL,
	`cod_amount_sen` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `parcels_waybill_idx` ON `parcels` (`waybill_no`);--> statement-breakpoint
CREATE TABLE `verdicts` (
	`verdict_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`ledger_seq` integer NOT NULL,
	`decision` text NOT NULL,
	`inconsistency_score` integer NOT NULL,
	`pattern_score` integer NOT NULL,
	`flags_json` text NOT NULL,
	`abort_code` text,
	`requires_cosign` integer DEFAULT false NOT NULL,
	`courier_signature` text,
	`operator_signature` text,
	`operator_id` text,
	`explanation` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verdicts_event_uidx` ON `verdicts` (`event_id`);--> statement-breakpoint
CREATE INDEX `verdicts_triage_idx` ON `verdicts` (`decision`,`created_at`);