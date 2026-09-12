import { VerifyView } from "@/components/ledger/verify-view";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function VerifyPage() {
  const workbench = await getWorkbench();
  return <VerifyView scenarios={workbench.ledgerScenarios()} />;
}
