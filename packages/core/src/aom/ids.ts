// Stable AOM id construction (Doc 05 §1.1 — "안정적 고유 ID").
// Ids must be deterministic across runs (§19): derived from structural position,
// never from iteration counters that could reorder.

/** Slugify Korean/label text to an id-safe token (deterministic, lossy). */
export function slug(s: string): string {
  return (
    s
      .normalize("NFKC")
      .replace(/\s+/g, "-")
      .replace(/[^0-9A-Za-z가-힣\-_.]/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "x"
  );
}

/** Build a namespaced id, e.g. aom("table","note11","rollforward"). */
export function aomId(...parts: string[]): string {
  return "aom:" + parts.map(slug).join(":");
}
