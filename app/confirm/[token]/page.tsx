import { ConfirmView } from "@/components/recipient/confirm-view";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const workbench = await getWorkbench();
  const { state, waybillNo } = workbench.getConfirmation(token);

  return <ConfirmView token={token} initial={state} waybillNo={waybillNo} />;
}
