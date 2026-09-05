/**
 * PNGを画素まで展開する。
 *
 * これまでの解析はチャンク構造だけを見ていたが、
 * ステガノグラフィは画素の中に隠すため、実際に絵を復元しないと手が出せない。
 * インターレース(Adam7)と16bit深度は未対応 — CTFで出る画像はほぼ非インターレースの8bit。
 */
import { u32be, ascii, startsWith } from "./bytes.ts";
import { inflateZlib } from "./inflate.ts";

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA 8bit × width × height */
  pixels: Uint8Array;
  colorType: number;
  bitDepth: number;
}

export interface DecodeFailure { error: string; }

export async function decodePng(b: Uint8Array): Promise<DecodedImage | DecodeFailure> {
  if (!startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { error: "PNGシグネチャがない" };

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  let p = 8;
  while (p + 8 <= b.length) {
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    const data = p + 8;
    if (data + len + 4 > b.length) break;
    if (type === "IHDR") {
      width = u32be(b, data); height = u32be(b, data + 4);
      bitDepth = b[data + 8]; colorType = b[data + 9]; interlace = b[data + 12];
    } else if (type === "PLTE") palette = b.subarray(data, data + len);
    else if (type === "tRNS") trns = b.subarray(data, data + len);
    else if (type === "IDAT") idat.push(b.subarray(data, data + len));
    else if (type === "IEND") break;
    p = data + len + 4;
  }

  if (!width || !height) return { error: "IHDRを読めなかった" };
  if (interlace !== 0) return { error: "インターレース(Adam7)は未対応" };
  if (bitDepth !== 8) return { error: `ビット深度${bitDepth}は未対応（8のみ対応）` };
  if (width * height > 40_000_000) return { error: "画像が大きすぎる" };

  const channels = CHANNELS[colorType];
  if (!channels) return { error: `カラータイプ${colorType}は未対応` };
  if (colorType === 3 && !palette) return { error: "パレット画像なのにPLTEがない" };

  const raw = await inflateZlib(concat(idat));
  if (!raw) return { error: "IDATを展開できなかった（データが壊れている可能性）" };

  const bpp = channels; // 8bit深度なので1チャンネル=1バイト
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return { error: "展開後のデータが足りない（切り詰められている可能性）" };

  // フィルタを解除する。PNGは各行の先頭1バイトにフィルタ種別を持つ
  const un = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? un[dst + x - bpp] : 0;      // 左の画素
      const bb = y > 0 ? un[up + x] : 0;                // 上の画素
      const c = x >= bpp && y > 0 ? un[up + x - bpp] : 0; // 左上の画素
      un[dst + x] = (v + unfilter(filter, a, bb, c)) & 0xff;
    }
  }

  // RGBAに揃える。以降の処理をカラータイプごとに分岐させないため
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * bpp, d = i * 4;
    switch (colorType) {
      case 0: pixels[d] = pixels[d + 1] = pixels[d + 2] = un[s]; pixels[d + 3] = 255; break;
      case 2: pixels[d] = un[s]; pixels[d + 1] = un[s + 1]; pixels[d + 2] = un[s + 2]; pixels[d + 3] = 255; break;
      case 3: {
        const idx = un[s] * 3;
        pixels[d] = palette![idx]; pixels[d + 1] = palette![idx + 1]; pixels[d + 2] = palette![idx + 2];
        pixels[d + 3] = trns && un[s] < trns.length ? trns[un[s]] : 255;
        break;
      }
      case 4: pixels[d] = pixels[d + 1] = pixels[d + 2] = un[s]; pixels[d + 3] = un[s + 1]; break;
      case 6: pixels[d] = un[s]; pixels[d + 1] = un[s + 1]; pixels[d + 2] = un[s + 2]; pixels[d + 3] = un[s + 3]; break;
    }
  }
  return { width, height, pixels, colorType, bitDepth };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function unfilter(type: number, a: number, b: number, c: number): number {
  switch (type) {
    case 0: return 0;                       // None
    case 1: return a;                       // Sub: 左を予測値とする
    case 2: return b;                       // Up: 上を予測値とする
    case 3: return (a + b) >> 1;            // Average
    case 4: return paeth(a, b, c);          // Paeth
    default: return 0;
  }
}

/** 左・上・左上のうち、線形予測値に最も近いものを選ぶ */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, x) => s + x.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const x of parts) { o.set(x, p); p += x.length; }
  return o;
}

export function isImage(r: DecodedImage | DecodeFailure): r is DecodedImage {
  return (r as DecodedImage).pixels !== undefined;
}
