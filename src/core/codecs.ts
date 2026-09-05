/** CTFで頻出するエンコーディングのデコーダ群。全て失敗時 null を返す */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function isBase64Like(s: string): boolean {
  return s.length >= 12 && /^[A-Za-z0-9+/\-_]+={0,2}$/.test(s) && s.replace(/=+$/, "").length % 4 !== 1;
}
export function isBase32Like(s: string): boolean {
  return s.length >= 16 && /^[A-Z2-7]+={0,6}$/.test(s);
}
export function isHexLike(s: string): boolean {
  return s.length >= 8 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

export function base64Decode(s: string): Uint8Array | null {
  const clean = s.replace(/=+$/, "");
  const url = /[-_]/.test(clean);
  const alpha = url ? B64URL : B64;
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of clean) {
    const v = alpha.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out.length ? new Uint8Array(out) : null;
}

export function base32Decode(s: string): Uint8Array | null {
  const clean = s.replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out.length ? new Uint8Array(out) : null;
}

export function hexDecode(s: string): Uint8Array | null {
  if (s.length % 2) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) return null;
    out[i] = v;
  }
  return out;
}

/** シーザー暗号。n=13でROT13 */
export function rot(s: string, n: number): string {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + n) % 26) + base);
  });
}

/**
 * エンコード候補の切り出し。
 * 「文字列全体が丸ごとBase64」とは限らず、"decode me: NBSWY3DP..." のように
 * 文中に埋まっていることの方が多い。各符号の文字種の連続runを直接拾う。
 */
export interface Candidate { kind: "Base64" | "Base32" | "16進"; text: string; offset: number; }

export function findEncodedRuns(text: string, limit = 40): Candidate[] {
  const out: Candidate[] = [];
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) => taken.some(([s2, e2]) => a < e2 && s2 < b);
  const scan = (re: RegExp, kind: Candidate["kind"], ok: (s: string) => boolean) => {
    for (const m of text.matchAll(re)) {
      const t = m[0];
      if (!ok(t)) continue;
      const at = m.index ?? 0;
      // 16進 ⊂ Base32 ⊂ Base64 と文字種が包含関係にあるため、
      // 先に狭い符号で解釈できた領域は後続の広い符号では拾わない
      if (overlaps(at, at + t.length)) continue;
      taken.push([at, at + t.length]);
      out.push({ kind, text: t, offset: at });
      if (out.length >= limit) return;
    }
  };
  // 16進を先に見る: 16進文字列はBase64の文字種にも含まれるため
  scan(/[0-9a-fA-F]{16,}/g, "16進", isHexLike);
  scan(/[A-Z2-7]{16,}={0,6}/g, "Base32", isBase32Like);
  scan(/[A-Za-z0-9+/\-_]{16,}={0,2}/g, "Base64", isBase64Like);
  return out;
}
