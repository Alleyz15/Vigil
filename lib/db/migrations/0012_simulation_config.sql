ALTER TABLE `shipments` ADD `simulation_json` text;--> statement-breakpoint
ALTER TABLE `shipments` ADD `simulation_snapshot_json` text;--> statement-breakpoint
DROP TRIGGER `shipments_no_update`;--> statement-breakpoint
-- Assignment may fill realized evidence once. Approved inputs and legacy rows stay immutable.
CREATE TRIGGER `shipments_no_update` BEFORE UPDATE ON `shipments`
WHEN NOT (
  OLD.`simulation_json` IS NOT NULL
  AND OLD.`simulation_snapshot_json` IS NULL
  AND NEW.`simulation_snapshot_json` IS NOT NULL
  AND NEW.`shipment_id` IS OLD.`shipment_id`
  AND NEW.`idempotency_key` IS OLD.`idempotency_key`
  AND NEW.`request_hash` IS OLD.`request_hash`
  AND NEW.`origin_snapshot_id` IS OLD.`origin_snapshot_id`
  AND NEW.`reference_snapshot_id` IS OLD.`reference_snapshot_id`
  AND NEW.`origin_depot` IS OLD.`origin_depot`
  AND NEW.`destination_depot` IS OLD.`destination_depot`
  AND NEW.`local` IS OLD.`local`
  AND NEW.`declared_value_sen` IS OLD.`declared_value_sen`
  AND NEW.`cod_amount_sen` IS OLD.`cod_amount_sen`
  AND NEW.`recipient_channel` IS OLD.`recipient_channel`
  AND NEW.`recipient_name` IS OLD.`recipient_name`
  AND NEW.`demo_condition` IS OLD.`demo_condition`
  AND NEW.`simulation_json` IS OLD.`simulation_json`
  AND NEW.`created_at` IS OLD.`created_at`
)
BEGIN SELECT RAISE(ABORT, 'shipments is append-only: only a first simulation snapshot may be filled'); END;
