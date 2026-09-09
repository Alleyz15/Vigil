CREATE TABLE `pickup_points` (
	`pickup_point_id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`address` text NOT NULL,
	`biz_location` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pickup_points_biz_location_uidx` ON `pickup_points` (`biz_location`);--> statement-breakpoint
CREATE TABLE `reroute_proposals` (
	`proposal_id` text PRIMARY KEY NOT NULL,
	`source_event_id` text NOT NULL,
	`epc` text NOT NULL,
	`current_courier_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_label` text NOT NULL,
	`target_biz_location` text NOT NULL,
	`target_lat` real NOT NULL,
	`target_lng` real NOT NULL,
	`authorizing_mandate_id` text NOT NULL,
	`approval_state` text DEFAULT 'pending_operator_cosignature' NOT NULL,
	`credential_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reroute_proposals_event_uidx` ON `reroute_proposals` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `reroute_proposals_state_idx` ON `reroute_proposals` (`approval_state`,`created_at`);