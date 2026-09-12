import { DivergenceMatrix } from "@/components/evidence/divergence-matrix";
import { MEASURED_MODELS, readDivergence } from "@/lib/evidence/e4";

export const dynamic = "force-dynamic";

export default function ModelDivergencePage() {
  const report = readDivergence();

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Why the model does not decide</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          The same three events, put to three model families and to the deterministic engine. Each
          model is perfectly consistent with itself and they do not agree with each other — so the
          verdict would depend on which vendor was configured. That is the reason the engine
          decides and the model never does.
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          {Object.values(MEASURED_MODELS).join(" · ")}
        </p>
      </header>

      <DivergenceMatrix report={report} />
    </div>
  );
}
