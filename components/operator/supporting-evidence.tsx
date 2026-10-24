import { Download, FileQuestion } from "lucide-react";
import type { EvidenceRequestView } from "@/lib/workbench/operations-types";

export function SupportingEvidence({ rounds, closed, archivedEvidenceCount = 0 }: {
  rounds: EvidenceRequestView[];
  closed: boolean;
  archivedEvidenceCount?: number;
}) {
  if (rounds.length === 0 && archivedEvidenceCount <= 0) return null;
  return (
    <section aria-label="Supporting evidence" className="min-w-0 border-y py-4">
      <header className="flex flex-wrap items-center gap-2">
        <FileQuestion className="size-4" aria-hidden="true" />
        <h2 className="text-base font-semibold">Supporting evidence</h2>
        {closed && <span className="text-xs text-muted-foreground">Closed / read-only</span>}
      </header>
      {archivedEvidenceCount > 0 && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          <span className="font-semibold text-foreground">{archivedEvidenceCount} archived evidence {archivedEvidenceCount === 1 ? "request" : "requests"}</span>
          <span className="block">Earlier workflow evidence is archived and is not applied to this run.</span>
        </p>
      )}
      <p className="mt-2 text-xs leading-5 text-muted-foreground">Attachments are unverified supporting material. They do not change rule scores or prove delivery. SHA-256 records file integrity, not truth or authenticity.</p>
      {rounds.length > 0 && <ol className="mt-3 divide-y">
        {rounds.map((round, index) => (
          <li key={round.requestId} className="min-w-0 py-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h3 className="text-sm font-semibold">Round {index + 1}</h3>
              <span className="text-xs text-muted-foreground">Requested by {round.operatorId} for {round.courierId}</span>
              <time className="text-xs text-muted-foreground" dateTime={round.requestedAt}>{round.requestedAt}</time>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5">{round.note}</p>
            {round.submission ? (
              <div className="mt-3 min-w-0 border-t pt-3">
                <p className="text-xs font-semibold">Courier submission</p>
                <time className="mt-1 block text-xs text-muted-foreground" dateTime={round.submission.submittedAt}>{round.submission.submittedAt}</time>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5">{round.submission.explanation}</p>
                {round.submission.attachments.length > 0 ? (
                  <ul className="mt-3 divide-y">
                    {round.submission.attachments.map((file) => (
                      <li key={file.attachmentId} className="min-w-0 py-2 text-xs">
                        <a className="inline-flex max-w-full items-start gap-2 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                          href={`/api/evidence/attachments/${encodeURIComponent(file.attachmentId)}?role=operator`}>
                          <Download className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 break-all">{file.name}</span>
                        </a>
                        <p className="mt-1 break-all text-muted-foreground">{file.mimeType} / {file.size.toLocaleString("en-MY")} bytes</p>
                        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-muted-foreground"><dt>SHA-256</dt><dd className="break-all font-mono">{file.sha256}</dd></dl>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-2 text-xs text-muted-foreground">No attachments submitted.</p>}
              </div>
            ) : <p className="mt-2 text-xs text-muted-foreground">{closed ? "Closed without a courier submission." : "Awaiting courier submission."}</p>}
          </li>
        ))}
      </ol>}
    </section>
  );
}
