// Minimal, dependency-free ZIP reader for .dsd containers (Doc 03 §2.1, §3.1).
// A .dsd is a ZIP archive; entries are STORE (0) or DEFLATE (8). We only read —
// never write back into the archive (§7 Original Preservation).
//
// We read the Central Directory (authoritative sizes/offsets), then pull each
// entry's bytes from its Local File Header. No streaming, no external deps:
// keeps @ari/core pure and offline (CLAUDE.md: core has zero UI/network deps).

import { inflateRawSync } from "node:zlib";

/**
 * Raw-deflate decompressor. Defaults to Node's zlib; the browser build swaps in
 * a pure-JS inflate so the same reader runs with no Node present.
 */
export type InflateRaw = (data: Uint8Array) => Uint8Array;
let inflateImpl: InflateRaw = (d) => new Uint8Array(inflateRawSync(d));

/** Replace the decompressor (used by the browser bundle). */
export function setInflateRaw(fn: InflateRaw): void {
  inflateImpl = fn;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800; // general-purpose bit 11: filename is UTF-8

export interface ZipEntry {
  /** Decoded file name (UTF-8, or legacy EUC-KR when bit 11 is unset). */
  name: string;
  method: number; // 0 = store, 8 = deflate
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** Decompressed bytes. */
  data: Uint8Array;
}

function u16(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8)) >>> 0;
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** Locate the End Of Central Directory record by scanning backwards. */
function findEocd(b: Uint8Array): number {
  // EOCD is 22 bytes + optional comment; scan the last 64KiB + 22.
  const min = Math.max(0, b.length - (0xffff + 22));
  for (let i = b.length - 22; i >= min; i--) {
    if (u32(b, i) === SIG_EOCD) return i;
  }
  throw new Error("not a zip: EOCD signature not found");
}

function decodeName(bytes: Uint8Array, flags: number): string {
  const enc = (flags & FLAG_UTF8) !== 0 ? "utf-8" : "euc-kr";
  try {
    // Node 22 ships full ICU → EUC-KR/CP949 legacy names decode cleanly.
    return new TextDecoder(enc, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/**
 * Read all entries from a ZIP archive. Pure function over the input bytes;
 * the caller's original buffer is never mutated (§7).
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEocd(bytes);
  const total = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (u32(bytes, p) !== SIG_CENTRAL) {
      throw new Error(`corrupt zip: central header #${i} missing at ${p}`);
    }
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc32 = u32(bytes, p + 16);
    const compressedSize = u32(bytes, p + 20);
    const uncompressedSize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), flags);

    // Jump to the local header to find where the entry's bytes begin.
    if (u32(bytes, localOffset) !== SIG_LOCAL) {
      throw new Error(`corrupt zip: local header for ${name} missing`);
    }
    const lNameLen = u16(bytes, localOffset + 26);
    const lExtraLen = u16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = raw.slice(); // store: copy out so we never alias the original
    } else if (method === 8) {
      data = inflateImpl(raw);
    } else {
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }

    entries.push({ name, method, compressedSize, uncompressedSize, crc32, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
