import { CourierView } from "@/components/courier/courier-view";
import { getWorkbench } from "@/lib/workbench";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CourierPage({ searchParams }: { searchParams: Promise<{ courierId?: string }> }) {
  const { courierId } = await searchParams;
  const workbench = await getWorkbench();
  const roster = workbench.dispatchWorkspace().couriers;
  if (courierId && !roster.some((courier) => courier.subject === courierId)) notFound();
  return <CourierView initial={workbench.courierWorkspace(courierId)} />;
}
