import { DivergenceMatrix } from "@/components/evidence/divergence-matrix";
import { readDivergence } from "@/lib/evidence/e4";

export const dynamic = "force-dynamic";

export default function ModelDivergencePage() {
  const report = readDivergence();

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-3xl font-semibold">Why the model does not decide</h1>
        <p className="mt-2 max-w-4xl text-base leading-7 text-muted-foreground">
          The same three events, put to three model families and to the deterministic engine. Each
          model is perfectly consistent with itself, but vendors do not always agree with each other.
        </p>
      </header>

      <DivergenceMatrix report={report} />
    </div>
  );
}
