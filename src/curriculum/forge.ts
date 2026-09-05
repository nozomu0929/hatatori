/**
 * 問題ファイルの組み立て。
 * ブラウザでもNodeでも動く必要があるため、標準APIのみで書く
 * （端末上で問題を生成するので、問題ファイルの配信そのものが不要になる）。
 */
import { encodeRgbPng, pngChunk, PNG_SIG } from "../core/png-encode.ts";
import { crc32 } from "../core/crc32.ts";  // ZIPのエントリ検査に必要

export { pngChunk, PNG_SIG };

const enc = new TextEncoder();

export function cat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const x of parts) { o.set(x, p); p += x.length; }
  return o;
}
export const utf8 = (s: string) => enc.encode(s);
export const be32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const le32 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
export const le16 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255]);

export interface PngOptions {
  width: number;
  height: number;
  /** IHDRの直後に挿入する追加チャンク（tEXtなど） */
  extraChunks?: Uint8Array[];
  /** 画素を決める関数。省略時はグラデーション */
  pixel?: (x: number, y: number) => [number, number, number];
  /** 画素を直接与える（RGB, width*height*3）。pixel より優先される */
  rgb?: Uint8Array;
}

export async function makePng(o: PngOptions): Promise<Uint8Array> {
  const { width: w, height: h } = o;
  const px = o.pixel ?? ((x, y) => [(x * 7) & 255, (y * 11) & 255, 0x40]);
  const rgb = o.rgb ?? (() => {
    const buf = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = px(x, y);
        const d = (y * w + x) * 3;
        buf[d] = r; buf[d + 1] = g; buf[d + 2] = b;
      }
    }
    return buf;
  })();
  return encodeRgbPng(w, h, rgb, o.extraChunks ?? []);
}

export function textChunk(key: string, value: string): Uint8Array {
  return pngChunk("tEXt", cat(utf8(key), new Uint8Array([0]), utf8(value)));
}

export interface ZipEntry { name: string; data: Uint8Array; }

/** 無圧縮ZIPを組み立てる。展開側の実装差に左右されないよう方式0で統一 */
export function makeZip(files: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nm = utf8(f.name);
    const c = crc32(f.data);
    const local = cat(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), le16(20), le16(0), le16(0),
      le16(0), le16(0), le32(c), le32(f.data.length), le32(f.data.length),
      le16(nm.length), le16(0), nm, f.data);
    centrals.push(cat(new Uint8Array([0x50, 0x4b, 0x01, 0x02]), le16(20), le16(20), le16(0), le16(0),
      le16(0), le16(0), le32(c), le32(f.data.length), le32(f.data.length),
      le16(nm.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), nm));
    locals.push(local);
    offset += local.length;
  }
  const cd = cat(...centrals);
  return cat(...locals, cd, new Uint8Array([0x50, 0x4b, 0x05, 0x06]), le16(0), le16(0),
    le16(files.length), le16(files.length), le32(cd.length), le32(offset), le16(0));
}

// --- 符号化ヘルパ（問題を作る側なので、コア側のデコーダとは独立に持つ） ---
export function toBase64(b: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "", i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) { const n = b[i] << 16; out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + "=="; }
  else if (rest === 2) { const n = (b[i] << 16) | (b[i + 1] << 8); out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + "="; }
  return out;
}

export function toBase32(b: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "", buf = 0, bits = 0;
  for (const v of b) {
    buf = (buf << 8) | v; bits += 8;
    while (bits >= 5) { bits -= 5; out += A[(buf >> bits) & 31]; }
  }
  if (bits) out += A[(buf << (5 - bits)) & 31];
  while (out.length % 8) out += "=";
  return out;
}

export const toHex = (b: Uint8Array) => Array.from(b).map((v) => v.toString(16).padStart(2, "0")).join("");

export function rot(s: string, n: number): string {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + n) % 26) + base);
  });
}

export function xorBytes(b: Uint8Array, key: number): Uint8Array {
  const o = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b[i] ^ key;
  return o;
}

// ─────────── ステガノグラフィ ───────────
import { drawText, textWidth, GLYPH_H } from "./font.ts";

/**
 * ノイズを含む下地画像を作る。
 * 最下位ビットが規則的な下地だと「不自然なビット面」の検出が
 * 埋め込みの有無に関わらず反応してしまい、練習にならない。
 * 実写画像の最下位ビットは撮影ノイズでランダムになるので、それに倣う。
 */
export function noisyCanvas(rng: { int(n: number): number }, w: number, h: number): Uint8Array {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 3;
      // なだらかな階調にノイズを乗せる
      rgb[d]     = clamp(40 + ((x * 200) / w) + rng.int(24) - 12);
      rgb[d + 1] = clamp(60 + ((y * 160) / h) + rng.int(24) - 12);
      rgb[d + 2] = clamp(120 + rng.int(40) - 20);
    }
  }
  return rgb;
}
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** バイト列をR,G,Bの最下位ビットへ順に書き込む（見た目はほぼ変わらない） */
export function embedLsbBytes(rgb: Uint8Array, data: Uint8Array): void {
  const capacity = Math.floor(rgb.length / 8);
  if (data.length > capacity) throw new Error(`埋め込み容量が足りない（${data.length} > ${capacity}バイト）`);
  for (let i = 0; i < data.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const v = (data[i] >> (7 - bit)) & 1; // MSB先頭で詰める
      const idx = i * 8 + bit;
      rgb[idx] = (rgb[idx] & 0xfe) | v;
    }
  }
}

/**
 * 最下位ビット面に文字を「描く」。
 * 抽出したビット面を白黒画像として見ると文字が浮かび上がる。
 * バイト列として取り出しても意味を成さないので、目で見る以外に解きようがない
 * — これがステガノを学ぶ上で一番効く体験になる。
 */
export function embedLsbText(rgb: Uint8Array, w: number, h: number, text: string, scale: number): void {
  const tw = textWidth(text, scale);
  const x0 = Math.max(1, Math.floor((w - tw) / 2));
  const y0 = Math.max(1, Math.floor((h - GLYPH_H * scale) / 2));

  // まず面全体を0で塗り、文字の内側だけ1にする（白黒がはっきり出る）
  for (let i = 0; i < rgb.length; i++) rgb[i] &= 0xfe;
  drawText(text, x0, y0, scale, (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const d = (y * w + x) * 3;
    rgb[d] |= 1; rgb[d + 1] |= 1; rgb[d + 2] |= 1;
  });
}

/** 文字を描くのに必要な最小の画像サイズ */
export function sizeForText(text: string, scale: number, margin = 8): { width: number; height: number } {
  return { width: textWidth(text, scale) + margin * 2, height: GLYPH_H * scale + margin * 2 };
}
