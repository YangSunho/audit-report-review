// Reference Review — 주석/표/그림 참조 검토 (Doc 06 §3). Deterministic (§6).
//
// Input: the AOM (references + note blocks + lines). For each Reference:
//  1) resolve 주석N → NoteBlock(noteNo=N);
//  2) `unresolved` when the note number does not exist → review (§21);
//  3) `mismatch` when the note exists but its subject clearly does not match the
//     referencing account, AND another note matches better → suggest that note.
// Suggestions are proposals only; the original is never mutated (§7, Doc 06 §3).

import type {
  AomObject,
  FinancialStatementLine,
  NoteBlock,
  Reference,
  ReviewResult,
} from "../aom/types.js";
import { ENGINE_VERSION } from "./types.js";

export interface ReferenceReviewResult {
  results: ReviewResult[];
  /** Reference objects with resolution/suggestion filled in (copies; §7). */
  resolved: Reference[];
}

function tokens(s: string): string[] {
  return s
    .replace(/[()[\]{}·ㆍ,./]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/** Overlap score between an account name and a note title (shared 2+char tokens). */
function affinity(account: string, noteTitle: string): number {
  const a = new Set(tokens(account));
  if (a.size === 0) return 0;
  let hit = 0;
  for (const t of tokens(noteTitle)) if (a.has(t)) hit++;
  // also reward substring containment (계정명이 주석 제목에 포함)
  const acc = account.replace(/\s/g, "");
  const title = noteTitle.replace(/\s/g, "");
  if (acc.length >= 2 && (title.includes(acc) || acc.includes(title))) hit += 2;
  return hit;
}

export function checkReferences(objects: AomObject[]): ReferenceReviewResult {
  const notes = new Map<string, NoteBlock>();
  const lines = new Map<string, FinancialStatementLine>();
  const refs: Reference[] = [];
  for (const o of objects) {
    if (o.objectType === "NoteBlock") notes.set(o.noteNo, o);
    else if (o.objectType === "FinancialStatementLine") lines.set(o.id, o);
    else if (o.objectType === "Reference") refs.push(o);
  }

  const results: ReviewResult[] = [];
  const resolved: Reference[] = [];

  for (const ref of refs) {
    const n = ref.toLabel.replace(/[^\d]/g, "");
    const note = notes.get(n);
    const line = lines.get(ref.from);
    const account = line?.account ?? "";
    const src = [ref.source.xmlPath];

    if (!note) {
      resolved.push({ ...ref, status: "unresolved", suggestedFix: null });
      results.push({
        id: `${ref.id}:resolve`,
        objectType: "ReviewResult",
        check: "ReferenceResolve",
        targets: [ref.id],
        status: "review", // §21: unresolved → 검토 권장, not asserted error
        toleranceApplied: 0,
        engineVersion: ENGINE_VERSION,
        sourceRefs: src,
        note: `미해석 주석 참조: ${ref.toLabel}`,
      });
      continue;
    }

    // Note exists. High-precision mismatch rule (keeps FP≈0, Doc 06 §9):
    // flag only when the account EXACTLY names some note's title, that note is a
    // different number than cited, and the cited note is unrelated (affinity 0).
    const own = affinity(account, note.title);
    const squeeze = (s: string): string => s.replace(/\s/g, "");
    // The claim "this reference is wrong" is the only thing the app ever asserts
    // outright about a reference, so the evidence must be unambiguous:
    //  · the account name matches exactly ONE note title — two notes sharing the
    //    title leaves no basis for choosing between them;
    //  · the name is long enough that the match cannot be coincidental (2-char
    //    labels such as "자본" collide across unrelated notes).
    const exactAll =
      squeeze(account).length >= 3
        ? [...notes.values()].filter((nb) => squeeze(nb.title) === squeeze(account))
        : [];
    const exact = exactAll.length === 1 ? exactAll[0] : undefined;

    // …and only when the line does NOT already reference its correct note
    // (a line may legitimately cite several notes: 현금 → 주석6,7,35).
    const alreadyCitesCorrect = !!line && line.noteRef.includes(exact?.noteNo ?? "");
    if (exact && exact.noteNo !== n && own === 0 && !alreadyCitesCorrect) {
      resolved.push({
        ...ref,
        status: "mismatch",
        toResolved: note.id,
        suggestedFix: { from: n, to: exact.noteNo },
      });
      results.push({
        id: `${ref.id}:resolve`,
        objectType: "ReviewResult",
        check: "ReferenceResolve",
        targets: [ref.id, exact.id],
        status: "mismatch",
        toleranceApplied: 0,
        engineVersion: ENGINE_VERSION,
        sourceRefs: src,
        note: `참조 오기 의심: ${account} → ${ref.toLabel}(${note.title}); 권장 주석${exact.noteNo}(${exact.title})`,
      });
      continue;
    }

    resolved.push({ ...ref, status: "resolved", toResolved: note.id, suggestedFix: null });
    results.push({
      id: `${ref.id}:resolve`,
      objectType: "ReviewResult",
      check: "ReferenceResolve",
      targets: [ref.id, note.id],
      status: "match",
      toleranceApplied: 0,
      engineVersion: ENGINE_VERSION,
      sourceRefs: src,
    });
  }

  return { results, resolved };
}
