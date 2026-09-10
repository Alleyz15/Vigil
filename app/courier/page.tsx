import { CourierView } from "@/components/courier/courier-view";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function CourierPage() {
  const workbench = await getWorkbench();
  return <CourierView initial={workbench.listCourierDrafts()} />;
}
