import { InjectionPanel } from "@/components/evidence/injection-panel";
import { MEASURED_MODELS, readInjection } from "@/lib/evidence/e4";

export const dynamic = "force-dynamic";

export default function InjectionPage() {
  const report = readInjection();

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">What an injection can and cannot move</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Instruction-shaped text placed in four evidence fields a courier controls, then the same
          handoff put to three models and to the engine. The models moved. The engine did not —
          and the reason is not that it resisted.
        </p>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {Object.values(MEASURED_MODELS).join(" · ")}
        </p>
      </header>

      <InjectionPanel report={report} />
    </div>
  );
}
