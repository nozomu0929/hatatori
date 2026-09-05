import type { FlagHit } from "./types.ts";
import { ascii } from "./bytes.ts";

/**
 * よく使われるフラグ書式。
 * 既知の接頭辞ほど信頼度を高くし、汎用パターンは低めに出す
 * (ノイズを消すのではなく「確からしさ」として並べ替える設計)。
 */
export const KNOWN_PREFIXES = [
  "flag", "FLAG", "ctf", "CTF", "picoCTF", "HTB", "THM", "AKASEC",
  "SECCON", "TSGCTF", "zer0pts", "hitcon", "DUCTF", "uiuctf", "corctf",
];

export const GENERIC_FLAG = /[A-Za-z][A-Za-z0-9_.\-]{1,20}\{[\x20-\x7e]{1,200}?\}/g;

export function defaultPatterns(): RegExp[] {
  return [GENERIC_FLAG];
}

/** ユーザー指定の書式("picoCTF{...}" や正規表現)をパターンに変換 */
export function userPattern(spec: string): RegExp {
  if (spec.startsWith("/") && spec.lastIndexOf("/") > 0) {
    const end = spec.lastIndexOf("/");
    return new RegExp(spec.slice(1, end), spec.slice(end + 1) || "g");
  }
  if (spec.includes("{")) {
    const prefix = spec.slice(0, spec.indexOf("{"));
    return new RegExp(`${escapeRe(prefix)}\\{[\\x20-\\x7e]{1,200}?\\}`, "g");
  }
  return new RegExp(`${escapeRe(spec)}\\{[\\x20-\\x7e]{1,200}?\\}`, "g");
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * 一致した文字列を既知の接頭辞に貼り直す。
 *
 * バイナリ中のフラグは前後のデータと地続きになっていることが多く、
 * 直前の1バイトがたまたま印字可能文字だと "Rflag{...}" のように
 * 余計な文字を巻き込んで一致してしまう。
 * 接頭辞部分の末尾に既知のフラグ接頭辞が含まれていれば、そこから切り直す。
 */
function reanchor(value: string): string {
  const brace = value.indexOf("{");
  if (brace <= 0) return value;
  const prefix = value.slice(0, brace);
  if (KNOWN_PREFIXES.includes(prefix)) return value;
  // 長い接頭辞から順に見る（"picoCTF" が "CTF" に負けないように）
  const sorted = [...KNOWN_PREFIXES].sort((a, b) => b.length - a.length);
  for (const k of sorted) {
    if (prefix.length > k.length && prefix.endsWith(k)) return value.slice(prefix.length - k.length);
  }
  return value;
}

function scoreOf(value: string): number {
  const prefix = value.slice(0, value.indexOf("{"));
  if (KNOWN_PREFIXES.includes(prefix)) return 0.95;
  if (KNOWN_PREFIXES.some((p) => p.toLowerCase() === prefix.toLowerCase())) return 0.9;
  const body = value.slice(value.indexOf("{") + 1, -1);
  // 空や短すぎるもの、コード片(関数定義など)はフラグらしくない
  if (body.length < 3) return 0.2;
  if (/^\s*$/.test(body)) return 0.1;
  if (/[;=]\s*$/.test(body) || body.includes("  ")) return 0.25;
  return 0.55;
}

/** バイト列からフラグ候補を抽出 */
export function findFlags(
  bytes: Uint8Array,
  patterns: RegExp[],
  where: string,
  path: string[],
  viaStepId: string,
): FlagHit[] {
  const text = ascii(bytes);
  const seen = new Set<string>();
  const out: FlagHit[] = [];
  for (const pat of patterns) {
    const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g");
    for (const m of text.matchAll(re)) {
      const v = reanchor(m[0]);
      if (seen.has(v)) continue;
      seen.add(v);
      const conf = scoreOf(v);
      if (conf < 0.15) continue;
      out.push({ value: v, where, path, confidence: conf, viaStepId });
      if (out.length >= 50) return out;
    }
  }
  return out;
}
