CREATE TABLE `device_enrollments` (
	`device_id` text PRIMARY KEY NOT NULL,
	`courier_id` text NOT NULL,
	`required_recognition_verdict` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`enrolled_at` text NOT NULL,
	FOREIGN KEY (`courier_id`) REFERENCES `couriers`(`courier_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `device_enrollments_courier_status_idx` ON `device_enrollments` (`courier_id`,`status`);--> statement-breakpoint
CREATE TABLE `otp_challenges` (
	`challenge_id` text PRIMARY KEY NOT NULL,
	`epc` text NOT NULL,
	`recipient_channel_fingerprint` text NOT NULL,
	`delivery_status` text NOT NULL,
	`verification_receipt_id` text,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`verified_at` text,
	`consumed_by_event_id` text,
	FOREIGN KEY (`epc`) REFERENCES `parcels`(`epc`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `otp_challenges_epc_issued_idx` ON `otp_challenges` (`epc`,`issued_at`);