import type { RoleIdentity } from "./service";
import type { ShipmentRouteView } from "./read-model";

export type DispatchItem = {
  dispatchId: string;
  source: "online" | "registered";
  waybillNo: string;
  originLabel: string;
  destinationLabel: string;
  originDepot: string;
  destinationDepot: string;
  declaredValueSen: number;
  state: "awaiting_assignment" | "assigned";
  courierId: string | null;
  createdAt: string;
  available: boolean;
};

export type DispatchWorkspace = { couriers: RoleIdentity[]; items: DispatchItem[] };
export type EvidenceAttachmentView = {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
};
export type EvidenceSubmissionView = {
  submissionId: string;
  explanation: string;
  submittedAt: string;
  attachments: EvidenceAttachmentView[];
};
export type EvidenceRequestView = {
  requestId: string;
  eventId: string;
  courierId: string;
  operatorId: string;
  note: string;
  requestedAt: string;
  submission: EvidenceSubmissionView | null;
};
export type CourierEvidenceItem = {
  request: EvidenceRequestView;
  waybillNo: string;
  route: ShipmentRouteView;
  identity: RoleIdentity;
  findings: { id: string; label: string }[];
  state: string;
};
export const EVIDENCE_MAX_FILES = 3;
export const EVIDENCE_MAX_FILE_BYTES = 5 * 1024 * 1024;
