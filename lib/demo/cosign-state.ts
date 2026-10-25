import type { OperatorWorkbench } from "@/lib/workbench/service";
import {
  buildCosignChoices,
  buildCosignModel,
  cosignSubjectFromDetail,
  cosignSubjectFromDraft,
  cosignSubjectFromQueue,
  selectCosignChoice,
  type CosignChoice,
  type CosignModel,
} from "./cosign";

export type CosignPageState = {
  choices: CosignChoice[];
  selectedHandoffId: string;
  model: CosignModel;
};

/** Shared fleet-wide co-sign projection for the initial page and mutation responses. */
export function buildCosignPageState(
  workbench: OperatorWorkbench,
  requestedHandoffOrEventId?: string,
): CosignPageState | null {
  const workspace = workbench.courierWorkspace();
  const fleetItems = workspace.couriers?.flatMap((courier) => workbench.courierWorkspace(courier.subject).items) ?? workspace.items;
  const choices = buildCosignChoices(
    fleetItems,
    workbench.listHandoffs().items,
    workbench.listCourierDrafts(),
  );
  const requested = choices.find(
    (choice) => choice.handoffId === requestedHandoffOrEventId || choice.eventId === requestedHandoffOrEventId,
  );
  const selected = requested ?? selectCosignChoice(choices);
  if (!selected) return null;

  const detail = workbench.getHandoff(selected.eventId);
  const subject = selected.queueItem
    ? cosignSubjectFromQueue(selected.queueItem)
    : selected.draft
      ? cosignSubjectFromDraft(selected.draft)
      : detail
        ? cosignSubjectFromDetail(detail)
        : undefined;
  if (!subject) return null;

  const identities = workbench.identities();
  const courierIdentity = workbench.identityForHandoff(selected.eventId) ?? workspace.identity;
  return {
    choices,
    selectedHandoffId: selected.handoffId,
    model: buildCosignModel({
      subject,
      detail,
      identities: { courier: courierIdentity, operator: identities.operator },
    }),
  };
}
