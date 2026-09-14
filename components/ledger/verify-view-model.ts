export function tamperLineIndex(recordCount: number): number {
  return Math.min(2, Math.max(0, recordCount - 1));
}

export function ledgerPreview(text: string, limit = 2): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, limit);
}

export function compactLedgerPreview(
  text: string,
  lineLimit = 2,
  characterLimit = 180,
): string[] {
  return ledgerPreview(text, lineLimit).map((line) => {
    if (line.length <= characterLimit) return line;
    const contentLimit = Math.max(0, characterLimit - 3);
    return `${line.slice(0, contentLimit)}...`;
  });
}

export function ledgerKinds(text: string, limit = 4): string[] {
  return ledgerPreview(text, limit).map((line) => {
    try {
      const record = JSON.parse(line) as { kind?: unknown };
      return typeof record.kind === "string" ? record.kind : "unknown";
    } catch {
      return "malformed";
    }
  });
}
