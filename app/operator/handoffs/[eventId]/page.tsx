import { notFound } from "next/navigation";
import { HandoffDetailView } from "@/components/operator/handoff-detail";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function HandoffDetailPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const workbench = await getWorkbench();
  const detail = workbench.getHandoff(eventId);
  if (!detail) notFound();

  return <HandoffDetailView detail={detail} />;
}
