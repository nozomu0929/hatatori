import type { FileKind } from "./types.ts";
import { startsWith, printableRatio, ascii } from "./bytes.ts";

export interface Signature {
  id: string;
  label: string;
  /** マジックバイト(文字列 or バイト配列) */
  sig: number[] | string;
  /** シグネチャの位置オフセット(tarのように先頭でない形式がある) */
  at?: number;
  ext?: string;
  mime?: string;
  /** 埋め込み走査の対象にするか。頻出しすぎる短いシグネチャは除く */
  scannable?: boolean;
}

/**
 * ファイル形式表。
 * CTFで「画像の中にzipが隠れている」類を検出するため、
 * 判定用と埋め込み走査用を同じ表で兼用している。
 */
export const SIGNATURES: Signature[] = [
  { id: "png",   label: "PNG画像",        sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ext: "png", mime: "image/png", scannable: true },
  { id: "jpeg",  label: "JPEG画像",       sig: [0xff, 0xd8, 0xff], ext: "jpg", mime: "image/jpeg", scannable: true },
  { id: "gif",   label: "GIF画像",        sig: "GIF8", ext: "gif", mime: "image/gif", scannable: true },
  { id: "bmp",   label: "BMP画像",        sig: "BM", ext: "bmp", mime: "image/bmp" },
  { id: "webp",  label: "WebP画像",       sig: "WEBP", at: 8, ext: "webp", mime: "image/webp" },
  { id: "zip",   label: "ZIPアーカイブ",  sig: [0x50, 0x4b, 0x03, 0x04], ext: "zip", mime: "application/zip", scannable: true },
  { id: "gzip",  label: "gzip圧縮",       sig: [0x1f, 0x8b, 0x08], ext: "gz", scannable: true },
  { id: "bzip2", label: "bzip2圧縮",      sig: "BZh", ext: "bz2", scannable: true },
  { id: "xz",    label: "xz圧縮",         sig: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], ext: "xz", scannable: true },
  { id: "7z",    label: "7-Zip書庫",      sig: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], ext: "7z", scannable: true },
  { id: "rar",   label: "RAR書庫",        sig: "Rar!", ext: "rar", scannable: true },
  { id: "tar",   label: "tar書庫",        sig: "ustar", at: 257, ext: "tar", scannable: false },
  { id: "pdf",   label: "PDF文書",        sig: "%PDF", ext: "pdf", mime: "application/pdf", scannable: true },
  { id: "elf",   label: "ELF実行ファイル", sig: [0x7f, 0x45, 0x4c, 0x46], ext: "", scannable: true },
  { id: "pe",    label: "PE/EXE実行ファイル", sig: "MZ", ext: "exe" },
  { id: "macho", label: "Mach-O実行ファイル", sig: [0xcf, 0xfa, 0xed, 0xfe] },
  { id: "class", label: "Javaクラス",     sig: [0xca, 0xfe, 0xba, 0xbe] },
  { id: "wasm",  label: "WebAssembly",   sig: [0x00, 0x61, 0x73, 0x6d] },
  { id: "sqlite",label: "SQLiteデータベース", sig: "SQLite format 3", ext: "db", scannable: true },
  { id: "pcap",  label: "pcapキャプチャ", sig: [0xd4, 0xc3, 0xb2, 0xa1], ext: "pcap", scannable: true },
  { id: "pcapng",label: "pcapngキャプチャ", sig: [0x0a, 0x0d, 0x0d, 0x0a], ext: "pcapng" },
  { id: "ogg",   label: "Ogg音声",        sig: "OggS", ext: "ogg", scannable: true },
  { id: "riff",  label: "RIFF(WAV/AVI)",  sig: "RIFF", ext: "wav", scannable: true },
  { id: "mp3",   label: "MP3音声",        sig: "ID3", ext: "mp3" },
  { id: "pgp",   label: "PGPメッセージ",  sig: "-----BEGIN PGP", scannable: true },
  { id: "pem",   label: "PEM鍵/証明書",   sig: "-----BEGIN ", scannable: true },
];

export function detectKind(b: Uint8Array): FileKind {
  for (const s of SIGNATURES) {
    const at = s.at ?? 0;
    if (startsWith(b, s.sig, at)) {
      const sigTxt = typeof s.sig === "string" ? `"${s.sig}"` : s.sig.map((v) => v.toString(16).padStart(2, "0")).join(" ");
      return {
        id: s.id, label: s.label, mime: s.mime, ext: s.ext,
        evidence: `オフセット${at}のマジックバイトが ${sigTxt} と一致`,
      };
    }
  }
  // マジックバイトが無いものはテキストかどうかで判定する
  const head = b.subarray(0, Math.min(b.length, 4096));
  const ratio = printableRatio(head);
  if (ratio > 0.95) {
    const t = ascii(head).trimStart();
    if (t.startsWith("{") || t.startsWith("[")) return { id: "json", label: "JSONらしきテキスト", ext: "json", evidence: "印字可能文字ばかりで '{' か '[' から始まる" };
    if (/^<\?xml|^<!DOCTYPE|^<html/i.test(t)) return { id: "xml", label: "XML/HTML", ext: "html", evidence: "XML/HTML宣言で始まる" };
    return { id: "text", label: "プレーンテキスト", mime: "text/plain", ext: "txt", evidence: `印字可能文字が${(ratio * 100).toFixed(1)}%` };
  }
  return { id: "unknown", label: "不明なバイナリ", evidence: `既知のマジックバイトに一致せず、印字可能文字は${(ratio * 100).toFixed(1)}%` };
}

export interface EmbeddedHit { offset: number; sig: Signature; }

/**
 * binwalk相当の埋め込みファイル走査。
 * skipOffset0=true で「先頭 = そのファイル自身」を除外する。
 */
export function scanEmbedded(b: Uint8Array, skipOffset0 = true): EmbeddedHit[] {
  const hits: EmbeddedHit[] = [];
  for (const s of SIGNATURES) {
    if (!s.scannable) continue;
    const n = typeof s.sig === "string" ? Array.from(s.sig, (c) => c.charCodeAt(0)) : s.sig;
    if (n.length < 3) continue; // 誤検出が多すぎるので除外
    outer: for (let i = 0; i + n.length <= b.length; i++) {
      if (b[i] !== n[0]) continue;
      for (let j = 1; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
      if (skipOffset0 && i === 0) continue;
      hits.push({ offset: i, sig: s });
      if (hits.length > 200) break;
    }
  }
  return hits.sort((a, b2) => a.offset - b2.offset);
}
