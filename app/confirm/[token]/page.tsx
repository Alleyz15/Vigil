import { ConfirmView } from "@/components/recipient/confirm-view";
import { RecipientShell } from "@/components/shells/recipient-shell";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/** Human-readable time remaining, from the token's own expiry. */
function expiresIn(state: { status: string; row?: { expiresAt: string } }): string | null {
  if (state.status !== "open" || !state.row) return null;
  const ms = Date.parse(state.row.expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)} days`;
  if (hours >= 1) return `${hours} hours`;
  return `${Math.max(1, Math.floor(ms / 60_000))} minutes`;
}

export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const workbench = await getWorkbench();
  const { state, waybillNo } = workbench.getConfirmation(token);

  return (
    <RecipientShell expiresIn={expiresIn(state)}>
      <ConfirmView token={token} initial={state} waybillNo={waybillNo} />
    </RecipientShell>
  );
}
