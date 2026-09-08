import { z } from "zod";

/**
 * GS1 Core Business Vocabulary (CBV) terms, narrowed to the last-mile subset
 * Vigil actually models. Using CBV URIs rather than invented strings is what
 * lets us claim the synthetic data has the shape of a real GDEX-class feed.
 */

/** `why` — the business step the event represents. */
export const BizStep = z.enum([
  "urn:epcglobal:cbv:bizstep:receiving",
  "urn:epcglobal:cbv:bizstep:storing",
  "urn:epcglobal:cbv:bizstep:loading",
  "urn:epcglobal:cbv:bizstep:departing",
  "urn:epcglobal:cbv:bizstep:arriving",
  "urn:epcglobal:cbv:bizstep:unloading",
  "urn:epcglobal:cbv:bizstep:picking",
  "urn:epcglobal:cbv:bizstep:shipping",
  "urn:epcglobal:cbv:bizstep:transporting",
  "urn:epcglobal:cbv:bizstep:delivering",
  "urn:epcglobal:cbv:bizstep:accepting",
  "urn:epcglobal:cbv:bizstep:inspecting",
  "urn:epcglobal:cbv:bizstep:holding",
]);
export type BizStep = z.infer<typeof BizStep>;

/** `why` — the state the object is left in after the step. */
export const Disposition = z.enum([
  "urn:epcglobal:cbv:disp:active",
  "urn:epcglobal:cbv:disp:in_progress",
  "urn:epcglobal:cbv:disp:in_transit",
  "urn:epcglobal:cbv:disp:in_possession",
  "urn:epcglobal:cbv:disp:non_sellable_other",
  "urn:epcglobal:cbv:disp:retail_sold",
  "urn:epcglobal:cbv:disp:returned",
  "urn:epcglobal:cbv:disp:damaged",
  "urn:epcglobal:cbv:disp:stolen",
  "urn:epcglobal:cbv:disp:unknown",
]);
export type Disposition = z.infer<typeof Disposition>;

/** How the EPCs in this event relate to the step (`ADD`, `OBSERVE`, `DELETE`). */
export const Action = z.enum(["ADD", "OBSERVE", "DELETE"]);
export type Action = z.infer<typeof Action>;

/** `why` — links the event to a business transaction (a waybill, a manifest). */
export const BizTransaction = z.strictObject({
  type: z.enum([
    "urn:epcglobal:cbv:btt:po",
    "urn:epcglobal:cbv:btt:desadv",
    "urn:epcglobal:cbv:btt:inv",
    "urn:epcglobal:cbv:btt:bol",
  ]),
  bizTransaction: z.string().min(1),
});
export type BizTransaction = z.infer<typeof BizTransaction>;

/** `why` — the party a TransactionEvent moves custody to or from. */
export const PartyId = z
  .string()
  .regex(/^urn:epc:id:pgln:[\x21-\x7e]+$/, "must be a PGLN URI")
  .brand<"PartyId">();
export type PartyId = z.infer<typeof PartyId>;
