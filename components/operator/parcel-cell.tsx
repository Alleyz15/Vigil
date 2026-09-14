import Link from "next/link";
import type { HandoffSummary } from "@/lib/workbench";

/**
 * The parcel reference in a list row, saying what KIND of reference it is.
 *
 * The first rendering fell back to an EPC's serial when no waybill was on the
 * shipment, and printed `0614141.100003.7` in the column where every other row
 * printed `WB-2026-NNNNNN`. The data was right — S4 scans another courier's
 * parcel — but an EPC dressed as a waybill is a claim about the reference that
 * nobody made, the same class as inventing a coordinate for evidence without one
 * (rule 3e). So the waybill is looked up across the world, and when the parcel
 * is not on this shipment, or no waybill exists at all, the row says so.
 */
export function ParcelCell({ item, href }: { item: HandoffSummary; href?: string }) {
  return (
    <>
      <Link href={href ?? `/operator/handoffs/${item.eventId}`} className="font-mono text-xs font-semibold hover:underline">
        {item.parcel.idKind === "epc" ? `EPC ${item.parcel.waybillNo}` : item.parcel.waybillNo}
      </Link>
      {!item.parcel.onThisShipment && (
        <div className="mt-1 text-xs font-medium text-foreground">Not on this shipment</div>
      )}
    </>
  );
}
