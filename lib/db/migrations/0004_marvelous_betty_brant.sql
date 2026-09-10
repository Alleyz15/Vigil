CREATE TABLE `handoff_cases` (
	`case_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`scenario_id` text NOT NULL,
	`leg_index` integer NOT NULL,
	`state` text NOT NULL,
	`priority` integer NOT NULL,
	`reason` text NOT NULL,
	`payload_json` text NOT NULL,
	`context_json` text NOT NULL,
	`trace_json` text NOT NULL,
	`run_count` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`due_at` text,
	`updated_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handoff_cases_event_uidx` ON `handoff_cases` (`event_id`);--> statement-breakpoint
CREATE INDEX `handoff_cases_queue_idx` ON `handoff_cases` (`state`,`priority`,`created_at`);--> statement-breakpoint
CREATE TABLE `operator_actions` (
	`action_id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`action` text NOT NULL,
	`operator_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `handoff_cases`(`case_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `operator_actions_case_idx` ON `operator_actions` (`case_id`,`created_at`);