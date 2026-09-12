import { CourierView } from "@/components/courier/courier-view";
import { CourierShell } from "@/components/shells/courier-shell";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function CourierPage() {
  const workbench = await getWorkbench();

  return (
    <CourierShell identity={workbench.identities().courier}>
      <CourierView initial={workbench.listCourierDrafts()} />
    </CourierShell>
  );
}
