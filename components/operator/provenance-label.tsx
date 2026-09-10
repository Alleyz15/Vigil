import { Badge } from "@/components/ui/badge";

export function ProvenanceLabel({ children }: { children: React.ReactNode }) {
  return <Badge variant="outline" className="font-normal text-muted-foreground">{children}</Badge>;
}
