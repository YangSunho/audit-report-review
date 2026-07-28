// Shared OOXML helpers for .docx / .xlsx writers. Zero external deps, pure &
// deterministic: fixed timestamps + store-method ZIP → identical bytes for
// identical input (§19). Used by docx.ts and xlsx.ts.

export const enc = new TextEncoder();

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface Entry {
  name: string;
  data: Uint8Array;
}

/** Deterministic store-method (no compression) ZIP. */
export function zipStore(entries: Entry[]): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number): void => void out.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number): void =>
    void out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const bytes = (b: Uint8Array): void => {
    for (let i = 0; i < b.length; i++) out.push(b[i]!);
  };
  const DOS_TIME = 0; // fixed → deterministic
  const DOS_DATE = 0x21; // 1980-01-01

  const central: number[] = [];
  const cu16 = (v: number): void => void central.push(v & 0xff, (v >>> 8) & 0xff);
  const cu32 = (v: number): void =>
    void central.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const cbytes = (b: Uint8Array): void => {
    for (let i = 0; i < b.length; i++) central.push(b[i]!);
  };

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const offset = out.length;
    u32(0x04034b50);
    u16(20);
    u16(0);
    u16(0); // store
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(nameBytes.length);
    u16(0);
    bytes(nameBytes);
    bytes(e.data);
    cu32(0x02014b50);
    cu16(20);
    cu16(20);
    cu16(0);
    cu16(0);
    cu16(DOS_TIME);
    cu16(DOS_DATE);
    cu32(crc);
    cu32(e.data.length);
    cu32(e.data.length);
    cu16(nameBytes.length);
    cu16(0);
    cu16(0);
    cu16(0);
    cu16(0);
    cu32(0);
    cu32(offset);
    cbytes(nameBytes);
  }

  const cdOffset = out.length;
  bytes(Uint8Array.from(central));
  const cdSize = central.length;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(cdSize);
  u32(cdOffset);
  u16(0);

  return Uint8Array.from(out);
}
