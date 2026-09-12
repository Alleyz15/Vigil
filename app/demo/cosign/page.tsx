import Link from "next/link";
import { CosignSplit } from "@/components/demo/cosign-split";
import { buildCosignModel, COSIGN_SCENARIO } from "@/lib/demo/cosign";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function CosignPage() {
  const workbench = await getWorkbench();

  const drafts = workbench.listCourierDrafts();
  const draft = drafts.find((candidate) => candidate.scenarioId === COSIGN_SCENARIO) ?? drafts[0];

  if (!draft) {
    return (
      <main className="mx-auto max-w-prose px-6 py-16">
        <h1 className="text-base font-semibold">No handoff is held back for this demo</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The split screen follows a courier draft reserved from a seeded scenario. None is
          present in this process, so there is nothing to show — rather than a fabricated one.
        </p>
        <Link href="/operator/inbox" className="mt-6 inline-block text-sm underline">
          Back to the console
        </Link>
      </main>
    );
  }

  // `getHandoff` returns nothing until the courier submits and the draft is
  // promoted. That absence IS the first phase, so it is passed through rather
  // than guarded against.
  const detail = workbench.getHandoff(draft.eventId);

  // Nothing wraps the split view. Anything rendered beside it adds its height
  // to a `min-h-screen` layout and pushes the credential bar out of frame.
  return <CosignSplit model={buildCosignModel({ draft, detail, identities: workbench.identities() })} />;
}
