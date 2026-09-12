import { ConfirmView } from "@/components/recipient/confirm-view";
import { RecipientShell } from "@/components/shells/recipient-shell";
import { remainingLabel } from "@/lib/recipient";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const workbench = await getWorkbench();

  // `nowIso` is the instant the workbench judged this token against. The
  // remaining time is computed from it rather than from this request's clock,
  // because a second clock would disagree with the status it is describing.
  const { state, waybillNo, nowIso } = workbench.getConfirmation(token);

  return (
    <RecipientShell expiresIn={remainingLabel(state, nowIso)}>
      <ConfirmView token={token} initial={state} waybillNo={waybillNo} />
    </RecipientShell>
  );
}
