import { notFound } from "next/navigation";
import { HandoffDetailView } from "@/components/operator/handoff-detail";
import { handoffBackLink } from "@/components/operator/handoffs-workspace-model";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function HandoffDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { eventId } = await params;
  const { from } = await searchParams;
  const workbench = await getWorkbench();
  const detail = workbench.getHandoff(eventId);
  if (!detail) notFound();

  return <HandoffDetailView detail={detail} backLink={handoffBackLink(from)} />;
}
