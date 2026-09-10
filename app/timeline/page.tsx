import { redirect } from "next/navigation";

export default async function TimelineRedirect({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  redirect(scenario ? `/operator/handoffs?scenario=${encodeURIComponent(scenario)}` : "/operator/handoffs");
}
