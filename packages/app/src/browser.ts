// Browser entry point — the whole engine, running inside the page.
//
// Why: the app must work by double-clicking one file. No Node, no install, no
// server. The only Node-only piece was zlib's raw inflate, replaced here by
// DecompressionStream (built into every modern browser).

import { setInflateRaw } from "../../core/src/dsd/zip.js";
import { openDsdBytes, parseContentsSync } from "../../core/src/dsd/parser.js";
import { buildAom } from "../../core/src/aom/builder.js";
import { runEngine } from "../../core/src/engine/run.js";
import {
  APP_FULL_NAME,
  APP_RELEASED,
  APP_VERSION,
  AUTHOR,
  COPYRIGHT_YEAR,
  LICENSE,
} from "../../core/src/brand.js";
import {
  buildAuditReport,
  renderMarkdown,
  renderDocx,
  renderXlsx,
  buildAuditWorkbook,
  renderHtmlDashboard,
} from "../../core/src/report/index.js";

/** Raw-deflate via the browser's built-in DecompressionStream. */
async function inflateRawAsync(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Pre-inflate every deflated entry so the synchronous zip reader can stay
 * synchronous: we decompress up front, then hand the reader a lookup table.
 */
async function primeInflate(bytes: Uint8Array): Promise<void> {
  const cache = new Map<string, Uint8Array>();
  const key = (d: Uint8Array): string => `${d.length}:${d[0]}:${d[1]}:${d[d.length - 1]}`;

  // Walk the central directory to find each entry's raw compressed block.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) !== 0x06054b50) continue;
    let p = dv.getUint32(i + 16, true);
    const count = dv.getUint16(i + 10, true);
    for (let n = 0; n < count; n++) {
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      if (method === 8) {
        const lName = dv.getUint16(local + 26, true);
        const lExtra = dv.getUint16(local + 28, true);
        const start = local + 30 + lName + lExtra;
        const raw = bytes.subarray(start, start + compSize);
        cache.set(key(raw), await inflateRawAsync(raw));
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    break;
  }
  setInflateRaw((d) => {
    const hit = cache.get(key(d));
    if (!hit) throw new Error("압축 해제에 실패했습니다.");
    return hit;
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return (
    "sha256:" +
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

export interface BrowserResult {
  company: string;
  docName: string;
  /** "제32기 · 2025.01.01 ~ 2025.12.31 · 결산일 2025.12.31 현재" (추출 실패 시 빈 문자열) */
  period: string;
  /** 12개월 사업연도가 아니거나 전기와 기간 길이가 다를 때의 주의 문구 */
  periodCaveat: string;
  total: number;
  review: number;
  mismatch: number;
  score: number;
  dashboardHtml: string;
  markdown: string;
  docx: Uint8Array;
  xlsx: Uint8Array;
}

/** 시작 화면 하단에 표시할 개발자·버전 정보. 버전은 core/brand.ts 한 곳에서 관리한다. */
export const CREDIT = {
  author: AUTHOR,
  appName: APP_FULL_NAME,
  version: APP_VERSION,
  released: APP_RELEASED,
  year: COPYRIGHT_YEAR,
  license: LICENSE,
};

/** Run the full review over an uploaded file, entirely in the page. */
export async function reviewInBrowser(bytes: Uint8Array): Promise<BrowserResult> {
  await primeInflate(bytes);
  const hash = await sha256Hex(bytes);
  const open = openDsdBytes(bytes, hash);
  const parsed = parseContentsSync(open);
  const model = buildAom(parsed);
  const engine = runEngine(model);
  const doc = buildAuditReport(model, engine, parsed);
  const s = engine.summary;
  const docObj = model.objects.find((o) => o.objectType === "Document");
  return {
    company: docObj?.objectType === "Document" ? (docObj.company ?? "") : "",
    docName: docObj?.objectType === "Document" ? (docObj.docName ?? "감사보고서") : "감사보고서",
    period: docObj?.objectType === "Document" ? (docObj.fiscal?.label ?? "") : "",
    periodCaveat: docObj?.objectType === "Document" ? (docObj.fiscal?.caveat ?? "") : "",
    total: s.total,
    review: s.issues.review,
    mismatch: s.mismatches,
    score: Math.round((100 * (s.byStatus["match"] ?? 0)) / (s.total || 1)),
    dashboardHtml: renderHtmlDashboard(model, engine, parsed),
    markdown: renderMarkdown(doc),
    docx: renderDocx(doc),
    xlsx: renderXlsx(buildAuditWorkbook(model, engine, parsed)),
  };
}
