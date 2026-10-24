CREATE TABLE `dispatch_requests` (
	`dispatch_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`request_json` text NOT NULL,
	`state` text NOT NULL,
	`courier_id` text,
	`created_at` text NOT NULL,
	`assigned_at` text
);
--> statement-breakpoint
CREATE TABLE `evidence_attachments` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`bytes` blob NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `evidence_submissions`(`submission_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `evidence_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`courier_id` text NOT NULL,
	`operator_id` text NOT NULL,
	`note` text NOT NULL,
	`requested_at` text NOT NULL,
	`payload_hash` text NOT NULL,
	`sequence` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_event_round_uidx` ON `evidence_requests` (`event_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `evidence_submissions` (
	`submission_id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`explanation` text NOT NULL,
	`request_hash` text NOT NULL,
	`submitted_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `evidence_requests`(`request_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_submissions_request_id_unique` ON `evidence_submissions` (`request_id`);
