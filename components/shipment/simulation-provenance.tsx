export type SimulationProvenanceProps = {
  seed: string;
  version: string;
  conditions: Array<{ source: "environment" | "behavior"; code: string; label: string }>;
  history?: { runId: string; priorHandoffs: number; source: "simulated"; snapshotAt: string };
};

/** Display-only: callers supply the recorded snapshot; this component samples nothing. */
export function SimulationProvenance({ seed, version, conditions, history }: SimulationProvenanceProps) {
  return (
    <details className="rounded-md border bg-muted/20 p-3 text-xs leading-5">
      <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">
        Simulation provenance
      </summary>
      <div className="mt-3 space-y-4">
        <p className="text-muted-foreground">Simulated data · sampled conditions are not detected findings or proof of fraud.</p>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Seed</dt>
            <dd className="break-all font-mono select-all">{seed}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Profile version</dt>
            <dd className="break-all font-mono">{version}</dd>
          </div>
        </dl>
        <ConditionList title="Environmental conditions" source="environment" conditions={conditions} empty="No environmental conditions recorded." />
        <ConditionList title="Simulated behavior" source="behavior" conditions={conditions} empty="No simulated behavior recorded." />
        <div className="border-t pt-3">
          <p className="font-medium">Simulated courier history</p>
          {history ? (
            <>
              <p className="mt-1 text-muted-foreground">This snapshot belongs to the same courier within the named simulation run.</p>
              <dl className="mt-2 space-y-2">
                <div><dt className="text-muted-foreground">Simulation run</dt><dd className="break-all font-mono">{history.runId}</dd></div>
                <div><dt className="text-muted-foreground">History available at this snapshot</dt><dd>{history.priorHandoffs} prior handoffs</dd></div>
                <div><dt className="text-muted-foreground">Snapshot at</dt><dd><time dateTime={history.snapshotAt} className="break-all font-mono">{history.snapshotAt}</time></dd></div>
              </dl>
            </>
          ) : <p className="mt-1 text-muted-foreground">Simulated courier history was not provided.</p>}
        </div>
        <p className="text-muted-foreground">
          Replaying evidence requires the same seed, confirmed inputs, profile version and courier context.
          A seed alone does not reproduce new shipment IDs or keys.
        </p>
      </div>
    </details>
  );
}

function ConditionList({ title, source, conditions, empty }: {
  title: string;
  source: "environment" | "behavior";
  conditions: SimulationProvenanceProps["conditions"];
  empty: string;
}) {
  const entries = conditions.filter((condition) => condition.source === source);
  return (
    <section aria-label={title}>
      <h4 className="font-medium">{title}</h4>
      {entries.length ? (
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {entries.map((condition) => <li key={condition.code}>{condition.label} <span className="break-all font-mono text-muted-foreground">({condition.code})</span></li>)}
        </ul>
      ) : <p className="mt-1 text-muted-foreground">{empty}</p>}
    </section>
  );
}
