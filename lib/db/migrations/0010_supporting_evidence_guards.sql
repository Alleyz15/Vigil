CREATE TRIGGER evidence_requests_no_update BEFORE UPDATE ON evidence_requests BEGIN SELECT RAISE(ABORT, 'evidence requests are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER evidence_requests_no_delete BEFORE DELETE ON evidence_requests BEGIN SELECT RAISE(ABORT, 'evidence requests are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER evidence_submissions_no_update BEFORE UPDATE ON evidence_submissions BEGIN SELECT RAISE(ABORT, 'evidence submissions are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER evidence_submissions_no_delete BEFORE DELETE ON evidence_submissions BEGIN SELECT RAISE(ABORT, 'evidence submissions are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER evidence_attachments_no_update BEFORE UPDATE ON evidence_attachments BEGIN SELECT RAISE(ABORT, 'evidence attachments are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER evidence_attachments_no_delete BEFORE DELETE ON evidence_attachments BEGIN SELECT RAISE(ABORT, 'evidence attachments are append-only'); END;
