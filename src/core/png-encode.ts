/**
 * 最小限のPNGエンコーダ。
 * ビットプレーンを画像として提示するために解析側でも必要になるので、
 * 問題生成側(curriculum/forge)ではなくコアに置く。
 */
import { crc32 } from "./crc32.ts";

const enc = new TextEncoder();

function cat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const x of parts) { o.set(x, p); p += x.length; }
  return o;
}
const be32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const td = cat(enc.encode(type), data);
  return cat(be32(data.length), td, be32(crc32(td)));
}

export const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function deflateZlib(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** RGB（各画素3バイト）からPNGを作る。フィルタは使わない（種別0固定） */
export async function encodeRgbPng(
  width: number, height: number, rgb: Uint8Array, extraChunks: Uint8Array[] = [],
): Promise<Uint8Array> {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return cat(
    PNG_SIG,
    pngChunk("IHDR", cat(be32(width), be32(height), new Uint8Array([8, 2, 0, 0, 0]))),
    ...extraChunks,
    pngChunk("IDAT", await deflateZlib(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

/** バイト列をブラウザで表示できるdata URLにする */
export function toDataUrl(png: Uint8Array): string {
  let s = "";
  for (let i = 0; i < png.length; i += 0x8000) {
    s += String.fromCharCode(...png.subarray(i, i + 0x8000));
  }
  return "data:image/png;base64," + btoa(s);
}
