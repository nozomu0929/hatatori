/** バイト列ユーティリティ。ブラウザ/Node双方で動くよう標準APIのみ使用 */

export const enc = new TextEncoder();
export const dec = new TextDecoder("utf-8", { fatal: false });
export const latin1 = new TextDecoder("latin1");

export function ascii(b: Uint8Array, start = 0, len = b.length - start): string {
  return latin1.decode(b.subarray(start, start + len));
}

export function hex(b: Uint8Array, start = 0, len = Math.min(16, b.length - start)): string {
  return Array.from(b.subarray(start, start + len))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join(" ");
}

export function startsWith(b: Uint8Array, sig: number[] | string, at = 0): boolean {
  const s = typeof sig === "string" ? Array.from(sig, (c) => c.charCodeAt(0)) : sig;
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s[i]) return false;
  return true;
}

/** 部分列の全出現位置。埋め込みファイル走査の基礎 */
export function findAll(hay: Uint8Array, needle: number[] | string, limit = 64): number[] {
  const n = typeof needle === "string" ? Array.from(needle, (c) => c.charCodeAt(0)) : needle;
  const out: number[] = [];
  if (n.length === 0) return out;
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    if (hay[i] !== n[0]) continue;
    for (let j = 1; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    out.push(i);
    if (out.length >= limit) break;
  }
  return out;
}

export function u32be(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}
export function u32le(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}
export function u16le(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

/** テキストらしさの判定用。改行・タブも「読める文字」として数える */
const PRINTABLE_TEXT = (c: number) => (c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d;
/** strings(1)相当。改行は区切りなので含めない。含めると行をまたいで塊が融合する */
const PRINTABLE_STRICT = (c: number) => c >= 0x20 && c <= 0x7e;

export interface StringHit { offset: number; text: string; }

/** stringsコマンド相当。ASCIIとUTF-16LEの両方を拾う */
export function extractStrings(b: Uint8Array, min = 4, limit = 20000): StringHit[] {
  const out: StringHit[] = [];
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const ok = i < b.length && PRINTABLE_STRICT(b[i]);
    if (ok && start < 0) start = i;
    else if (!ok && start >= 0) {
      if (i - start >= min) out.push({ offset: start, text: ascii(b, start, i - start) });
      start = -1;
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 印字可能文字の比率。復号結果が「意味のあるテキストか」の判定に使う */
export function printableRatio(b: Uint8Array): number {
  if (b.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < b.length; i++) if (PRINTABLE_TEXT(b[i])) n++;
  return n / b.length;
}

/** シャノンエントロピー(bits/byte)。8に近いほど暗号化/圧縮を疑う */
export function entropy(b: Uint8Array): number {
  if (b.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < b.length; i++) freq[b[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (!freq[i]) continue;
    const p = freq[i] / b.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function xor(b: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i] ^ key[i % key.length];
  return out;
}

export function hexdump(b: Uint8Array, start = 0, len = 128): string {
  const lines: string[] = [];
  const end = Math.min(b.length, start + len);
  for (let i = start; i < end; i += 16) {
    const row = b.subarray(i, Math.min(i + 16, end));
    const h = Array.from(row).map((v) => v.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const a = Array.from(row).map((v) => (PRINTABLE_STRICT(v) ? String.fromCharCode(v) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${h}  |${a}|`);
  }
  return lines.join("\n");
}

export function hx(n: number): string { return "0x" + n.toString(16); }
