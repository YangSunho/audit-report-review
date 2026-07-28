// AOM schema & integrity validation (Doc 05 §5).
//  · Traceability (§20): every object needs source.dsdFileHash + source.xmlPath.
//  · Referential integrity: from/to/parent/child/table/resolved ids must exist.
//  · Reproducibility (§19): schema_version stamped; ids unique.
// Pure, deterministic — returns a stable, sorted list of violations.

import type { AomObject } from "./types.js";
import type { AomModel } from "./builder.js";

export interface ValidationIssue {
  objectId: string;
  objectType: string;
  code: string; // machine code, e.g. "missing-source-xmlpath"
  message: string;
}

const KNOWN_TYPES = new Set([
  "Document",
  "Section",
  "NoteBlock",
  "FinancialStatementTable",
  "FinancialStatementLine",
  "Reference",
  "NarrativeNumber",
  "RelationshipEdge",
]);

export function validateAom(model: AomModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();

  const add = (o: { id?: string; objectType?: string }, code: string, message: string): void => {
    issues.push({
      objectId: o.id ?? "<no-id>",
      objectType: o.objectType ?? "<unknown>",
      code,
      message,
    });
  };

  // First pass: id uniqueness + presence.
  for (const o of model.objects) {
    if (!o.id) add(o, "missing-id", "object has no id");
    else if (ids.has(o.id)) add(o, "duplicate-id", `duplicate id ${o.id}`);
    else ids.add(o.id);
  }

  const has = (ref: string): boolean => ids.has(ref);

  // Second pass: per-object rules.
  for (const o of model.objects) {
    if (!KNOWN_TYPES.has(o.objectType)) add(o, "unknown-type", `unknown objectType ${o.objectType}`);

    // §20 traceability — mandatory source.
    const src = (o as AomObject).source;
    if (!src) add(o, "missing-source", "§20: object has no source");
    else {
      if (!src.dsdFileHash) add(o, "missing-source-hash", "§20: source.dsdFileHash required");
      if (src.dsdFileHash && src.dsdFileHash !== model.dsdFileHash)
        add(o, "source-hash-mismatch", "source.dsdFileHash != model hash");
      if (!src.xmlPath) add(o, "missing-source-xmlpath", "§20: source.xmlPath required");
    }

    // §19 schema version stamped.
    if ((o as AomObject).schemaVersion !== model.schemaVersion)
      add(o, "schema-version", `schemaVersion must be ${model.schemaVersion}`);

    // provenance present.
    if (!(o as AomObject).provenance) add(o, "missing-provenance", "provenance required");

    // Referential integrity per type.
    switch (o.objectType) {
      case "Document":
        for (const s of o.sectionIds) if (!has(s)) dangling(add, o, "sectionIds", s);
        if (!o.extractions) add(o, "missing-extractions", "Document.extractions required");
        break;
      case "Section":
        if (o.parentId && !has(o.parentId)) dangling(add, o, "parentId", o.parentId);
        for (const c of o.childIds) if (!has(c)) dangling(add, o, "childIds", c);
        for (const t of o.tableIds) if (!has(t)) dangling(add, o, "tableIds", t);
        break;
      case "NoteBlock":
        if (!/^\d+$/.test(o.noteNo)) add(o, "bad-note-no", `noteNo must be numeric (${o.noteNo})`);
        for (const t of o.tableIds) if (!has(t)) dangling(add, o, "tableIds", t);
        break;
      case "FinancialStatementTable":
        if (!o.statement) add(o, "missing-statement", "FinancialStatementTable.statement required");
        if (!o.tableType) add(o, "missing-tabletype", "tableType required");
        if (!o.period?.current) add(o, "missing-period", "period.current required");
        if (!Array.isArray(o.rows)) add(o, "missing-rows", "rows required");
        break;
      case "FinancialStatementLine":
        if (!o.account) add(o, "missing-account", "account required");
        if (!o.amount?.current) add(o, "missing-amount", "amount.current required");
        else if (!Number.isInteger(o.amount.current.value))
          add(o, "non-integer-amount", "§19: amount must be integer KRW");
        break;
      case "Reference":
        if (!has(o.from)) dangling(add, o, "from", o.from);
        if (o.status === "resolved" && (!o.toResolved || !has(o.toResolved)))
          add(o, "unresolved-target", "resolved Reference must point to an existing object");
        break;
      case "RelationshipEdge":
        if (!has(o.from)) dangling(add, o, "from", o.from);
        if (!has(o.to)) dangling(add, o, "to", o.to);
        break;
      case "NarrativeNumber":
        for (const l of o.linksTo) if (!has(l)) dangling(add, o, "linksTo", l);
        break;
    }
  }

  issues.sort((a, b) =>
    a.objectId === b.objectId ? a.code.localeCompare(b.code) : a.objectId.localeCompare(b.objectId),
  );
  return issues;
}

function dangling(
  add: (o: { id?: string; objectType?: string }, code: string, message: string) => void,
  o: { id?: string; objectType?: string },
  field: string,
  ref: string,
): void {
  add(o, "dangling-ref", `${field} → ${ref} does not exist`);
}
