import Link from "next/link";
import { CosignSplit } from "@/components/demo/cosign-split";
import {
  buildCosignChoices,
  buildCosignModel,
  cosignSubjectFromDetail,
  cosignSubjectFromDraft,
  cosignSubjectFromQueue,
  selectCosignChoice,
} from "@/lib/demo/cosign";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function CosignPage({
  searchParams,
}: {
  searchParams: Promise<{ handoff?: string }>;
}) {
  const workbench = await getWorkbench();

  const workspace = workbench.courierWorkspace();
  const choices = buildCosignChoices(
    workspace.items,
    workbench.listHandoffs().items,
    workbench.listCourierDrafts(),
  );
  const requested = (await searchParams).handoff;
  const selected = selectCosignChoice(choices, requested);

  if (!selected) {
    return (
      <main className="mx-auto max-w-prose px-6 py-16">
        <h1 className="text-base font-semibold">No handoff is held back for this demo</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          No prepared or completed delivery handoff exists in this process, so there is nothing
          to show — rather than a fabricated credential ceremony.
        </p>
        <Link href="/operator/inbox" className="mt-6 inline-block text-sm underline">
          Back to the console
        </Link>
      </main>
    );
  }

  const detail = workbench.getHandoff(selected.eventId);
  const subject = selected.queueItem
    ? cosignSubjectFromQueue(selected.queueItem)
    : selected.draft
      ? cosignSubjectFromDraft(selected.draft)
      : detail
        ? cosignSubjectFromDetail(detail)
        : undefined;

  if (!subject) {
    return (
      <main className="mx-auto max-w-prose px-6 py-16">
        <h1 className="text-base font-semibold">This handoff is no longer available</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The selector found a summary without a corresponding handoff record. Choose another
          delivery rather than displaying guessed credential state.
        </p>
        <Link href="/demo/cosign" className="mt-6 inline-block text-sm underline">
          Open the handoff selector
        </Link>
      </main>
    );
  }

  // `getHandoff` returns nothing until the courier submits and the prepared scan is
  // promoted. That absence IS the first phase, so it is passed through rather
  // than guarded against.
  const identities = workbench.identities();
  const courierIdentity = workbench.identityForHandoff(selected.eventId) ?? workspace.identity;

  // Nothing wraps the split view. Anything rendered beside it adds its height
  // to a `min-h-screen` layout and pushes the credential bar out of frame.
  return (
    <CosignSplit
      key={selected.handoffId}
      choices={choices}
      selectedHandoffId={selected.handoffId}
      model={buildCosignModel({
        subject,
        detail,
        identities: { courier: courierIdentity, operator: identities.operator },
      })}
    />
  );
}
