import Link from "next/link";
import { CosignSplit } from "@/components/demo/cosign-split";
import { buildCosignPageState } from "@/lib/demo/cosign-state";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function CosignPage({
  searchParams,
}: {
  searchParams: Promise<{ handoff?: string }>;
}) {
  const workbench = await getWorkbench();

  const requested = (await searchParams).handoff;
  const state = buildCosignPageState(workbench, requested);

  if (!state) {
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

  // Nothing wraps the split view. Anything rendered beside it adds its height
  // to a `min-h-screen` layout and pushes the credential bar out of frame.
  return (
    <CosignSplit
      key={state.selectedHandoffId}
      choices={state.choices}
      selectedHandoffId={state.selectedHandoffId}
      model={state.model}
    />
  );
}
