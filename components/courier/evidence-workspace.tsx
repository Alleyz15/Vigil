"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Download, FileText, Paperclip, Send, X } from "lucide-react";
import { EVIDENCE_MAX_FILES, EVIDENCE_MAX_FILE_BYTES, type CourierEvidenceItem } from "@/lib/workbench/operations-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RouteSummary } from "@/components/shipment/route-summary";
import { cn } from "@/lib/utils";

export type EvidenceDraft = { submissionId: string; explanation: string; files: File[] };

function evidenceStateLabel(item: CourierEvidenceItem): string {
  if (item.state.startsWith("resolved_")) return `Resolved: ${item.state.slice(9)}`;
  if (item.request.submission) return "Submitted";
  if (item.state === "awaiting_evidence") return "Response requested";
  return item.state.replaceAll("_", " ");
}

export function EvidenceWorkspace({ items, selected, onSelect, draft, onChange, onSubmit, busy }: {
  items: CourierEvidenceItem[];
  selected: CourierEvidenceItem | undefined;
  onSelect: (requestId: string) => void;
  draft: EvidenceDraft | undefined;
  onChange: (patch: Partial<Pick<EvidenceDraft, "explanation" | "files">>) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div className="courier-workspace mt-6">
      <section aria-label="Evidence request list" className="min-w-0 overflow-hidden rounded-lg border bg-card">
        <h2 className="border-b p-5 text-sm font-semibold">Requests and history <Badge variant="secondary">{items.length}</Badge></h2>
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.request.requestId}>
              <button type="button" disabled={busy} aria-pressed={selected?.request.requestId === item.request.requestId}
                onClick={() => onSelect(item.request.requestId)}
                className={cn("w-full space-y-2 p-5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60", selected?.request.requestId === item.request.requestId && "bg-sidebar-accent")}>
                <span className="block break-all font-mono text-xs">{item.waybillNo}</span>
                <span className="block text-sm">{evidenceStateLabel(item)}</span>
                <span className="block text-xs text-muted-foreground">{item.request.note}</span>
                <time className="block break-all text-xs text-muted-foreground" dateTime={item.request.requestedAt}>{item.request.requestedAt}</time>
              </button>
            </li>
          ))}
        </ul>
        {items.length === 0 && <p className="p-5 text-sm text-muted-foreground">No evidence requests for this courier.</p>}
      </section>
      {selected && <EvidenceDetail key={selected.request.requestId} item={selected} draft={draft} onChange={onChange} onSubmit={onSubmit} busy={busy} />}
    </div>
  );
}

function EvidenceDetail({ item, draft, onChange, onSubmit, busy }: {
  item: CourierEvidenceItem;
  draft: EvidenceDraft | undefined;
  onChange: (patch: Partial<Pick<EvidenceDraft, "explanation" | "files">>) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const id = useId();
  const [fileError, setFileError] = useState<string | null>(null);
  const files = draft?.files ?? [];
  const { request } = item;
  const editable = item.state === "awaiting_evidence" && !request.submission;

  function addFiles(incoming: File[]) {
    if (files.length + incoming.length > EVIDENCE_MAX_FILES) {
      setFileError("Attach at most three files."); return;
    }
    for (const file of incoming) {
      const matches = (file.type === "image/jpeg" && /\.jpe?g$/i.test(file.name))
        || (file.type === "image/png" && /\.png$/i.test(file.name))
        || (file.type === "application/pdf" && /\.pdf$/i.test(file.name));
      if (!matches) { setFileError("Choose JPEG, PNG or PDF files with matching file extensions."); return; }
      if (file.size > EVIDENCE_MAX_FILE_BYTES) { setFileError("Each file must be 5 MiB or smaller."); return; }
    }
    setFileError(null);
    onChange({ files: [...files, ...incoming] });
  }

  return (
    <section aria-label="Selected evidence request" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="space-y-3 border-b p-5">
        <h2 className="break-all text-sm font-semibold">{item.waybillNo}</h2>
        <p className="text-xs text-muted-foreground">{evidenceStateLabel(item)}</p>
        <RouteSummary route={item.route} />
        <p className="break-all font-mono text-xs text-muted-foreground">{request.eventId}</p>
      </div>
      <div className="space-y-4 border-b p-5">
        <div><h3 className="text-sm font-semibold">Operator note</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{request.note}</p><p className="mt-2 text-xs text-muted-foreground">{request.operatorId} · {request.requestedAt}</p></div>
        {item.findings.length > 0 && <div><h3 className="text-sm font-semibold">Findings</h3><ul className="mt-2 space-y-2">{item.findings.map((finding) => <li key={finding.id} className="text-sm"><span className="mr-2 font-mono text-xs text-muted-foreground">{finding.id}</span>{finding.label}</li>)}</ul></div>}
      </div>
      {request.submission ? (
        <div className="space-y-3 p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 aria-hidden="true" className="size-4 text-emerald-700" />Evidence submitted</h3>
          <p className="whitespace-pre-wrap break-words text-sm">{request.submission.explanation}</p>
          <dl className="space-y-2 text-xs text-muted-foreground"><div><dt>Submission receipt</dt><dd className="break-all font-mono">{request.submission.submissionId}</dd></div><div><dt>Submitted at</dt><dd>{request.submission.submittedAt}</dd></div></dl>
          <ul className="space-y-2">{request.submission.attachments.map((attachment) => <li key={attachment.attachmentId}><a className="inline-flex max-w-full items-start gap-2 text-sm text-primary underline underline-offset-4" href={`/api/evidence/attachments/${encodeURIComponent(attachment.attachmentId)}?courierId=${encodeURIComponent(request.courierId)}`}><Download aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="break-all">{attachment.name}</span></a></li>)}</ul>
          <p className="text-xs text-muted-foreground">Supporting material is unverified. The operator reviews it; the original findings stay on record.</p>
        </div>
      ) : editable ? (
        <form className="space-y-4 p-5" onSubmit={(event) => { event.preventDefault(); if (!busy && draft?.explanation.trim()) onSubmit(); }}>
          <div className="space-y-2"><label htmlFor={`${id}-explanation`} className="block text-sm font-medium">Explanation</label><textarea id={`${id}-explanation`} required disabled={busy} rows={5} value={draft?.explanation ?? ""} onChange={(event) => onChange({ explanation: event.target.value })} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60" /></div>
          <div className="space-y-2"><label htmlFor={`${id}-files`} className="flex items-center gap-2 text-sm font-medium"><Paperclip aria-hidden="true" className="size-4" />Attachments</label><p id={`${id}-limits`} className="text-xs text-muted-foreground">Optional: up to 3 JPEG, PNG or PDF files, 5 MiB each.</p><input id={`${id}-files`} aria-describedby={`${id}-limits`} type="file" multiple accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" disabled={busy} className="block w-full min-w-0 text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-2 file:text-sm" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></div>
          {fileError && <p role="alert" className="text-sm text-red-700">{fileError}</p>}
          <ul className="space-y-2">{files.map((file, index) => <li key={`${index}:${file.name}:${file.lastModified}`} className="flex min-w-0 items-center gap-3 border-b pb-2"><LocalPreview file={file} /><span className="min-w-0 flex-1 break-all text-sm">{file.name}<span className="block text-xs text-muted-foreground">{Math.ceil(file.size / 1024)} KiB</span></span><Button type="button" variant="ghost" size="icon" title={`Remove ${file.name}`} aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => { setFileError(null); onChange({ files: files.filter((_, i) => i !== index) }); }}><X aria-hidden="true" className="size-4" /></Button></li>)}</ul>
          <p className="text-xs text-muted-foreground">Supporting material is unverified and does not change the original findings.</p>
          <Button type="submit" size="sm" disabled={busy || !draft?.explanation.trim()}><Send aria-hidden="true" className="size-4" />{busy ? "Submitting evidence..." : "Submit evidence"}</Button>
        </form>
      ) : <p className="p-5 text-sm text-muted-foreground">This request is closed for responses. Stored evidence cannot restore an unavailable delivery workflow.</p>}
    </section>
  );
}

function LocalPreview({ file }: { file: File }) {
  const previewRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !file.type.startsWith("image/")) return;
    const objectUrl = URL.createObjectURL(file);
    preview.src = objectUrl;
    return () => { preview.removeAttribute("src"); URL.revokeObjectURL(objectUrl); };
  }, [file]);
  // Local previews use blob URLs, not remote or optimized Next.js images.
  // eslint-disable-next-line @next/next/no-img-element
  return file.type.startsWith("image/") ? <img ref={previewRef} alt={file.name} className="size-16 shrink-0 rounded-md border object-contain" /> : <FileText aria-hidden="true" className="size-8 shrink-0 text-muted-foreground" />;
}
