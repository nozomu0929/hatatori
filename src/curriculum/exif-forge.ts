/**
 * EXIFブロックの組み立て。
 * PNGの eXIf チャンクに入れる（JPEGを一から作るには
 * DCTとハフマン符号化の実装が要るが、PNGなら既存のエンコーダに載せられる）。
 * eXIf はPNG規格に定義された正式なチャンクで、exiftool も読む。
 */
import { cat, utf8 } from "./forge.ts";
import { pngChunk } from "../core/png-encode.ts";

const u16 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255]);
const u32 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

type Value =
  | { type: "ascii"; text: string }
  | { type: "short"; nums: number[] }
  | { type: "long"; nums: number[] }
  | { type: "rational"; pairs: [number, number][] };

export interface ExifEntry { tag: number; value: Value; }

export const asciiVal = (text: string): Value => ({ type: "ascii", text });
export const shortVal = (...nums: number[]): Value => ({ type: "short", nums });
export const rationalVal = (...pairs: [number, number][]): Value => ({ type: "rational", pairs });

const TYPE_ID = { ascii: 2, short: 3, long: 4, rational: 5 } as const;

function payload(v: Value): Uint8Array {
  switch (v.type) {
    case "ascii": return cat(utf8(v.text), new Uint8Array([0]));
    case "short": return cat(...v.nums.map(u16));
    case "long": return cat(...v.nums.map(u32));
    case "rational": return cat(...v.pairs.map(([n, d]) => cat(u32(n), u32(d))));
  }
}
function count(v: Value): number {
  switch (v.type) {
    case "ascii": return v.text.length + 1;
    case "short": return v.nums.length;
    case "long": return v.nums.length;
    case "rational": return v.pairs.length;
  }
}

/**
 * IFD（タグの一覧）を1つ組み立てる。
 * 4バイトに収まらない値は本体の後ろに置き、エントリにはその位置を書く。
 */
function buildIfd(entries: ExifEntry[], ifdOffset: number, extraPointers: { tag: number; target: number }[] = []) {
  const all = [
    ...entries.map((e) => ({ tag: e.tag, value: e.value as Value | null, target: 0 })),
    ...extraPointers.map((p) => ({ tag: p.tag, value: null, target: p.target })),
  ].sort((a, b) => a.tag - b.tag);

  const headerSize = 2 + all.length * 12 + 4;
  let dataOff = ifdOffset + headerSize;
  const dataParts: Uint8Array[] = [];
  const rows: Uint8Array[] = [];

  for (const e of all) {
    if (!e.value) { // ポインタタグ（サブIFDの位置）
      rows.push(cat(u16(e.tag), u16(TYPE_ID.long), u32(1), u32(e.target)));
      continue;
    }
    const bytes = payload(e.value);
    const n = count(e.value);
    const typeId = TYPE_ID[e.value.type];
    if (bytes.length <= 4) {
      const inline = new Uint8Array(4);
      inline.set(bytes, 0);
      rows.push(cat(u16(e.tag), u16(typeId), u32(n), inline));
    } else {
      rows.push(cat(u16(e.tag), u16(typeId), u32(n), u32(dataOff)));
      dataParts.push(bytes);
      dataOff += bytes.length;
      if (dataOff % 2) { dataParts.push(new Uint8Array(1)); dataOff++; } // 偶数境界に揃える
    }
  }
  return { block: cat(u16(all.length), ...rows, u32(0), ...dataParts), end: dataOff };
}

export interface ExifSpec {
  /** IFD0 に置くタグ（Make, Model, Software など） */
  main?: ExifEntry[];
  /** GPS IFD に置くタグ */
  gps?: ExifEntry[];
}

/** リトルエンディアン(II)のTIFF構造としてEXIFブロックを作る */
export function buildExif(spec: ExifSpec): Uint8Array {
  const header = cat(utf8("II"), u16(42), u32(8));
  const mainEntries = spec.main ?? [];
  const gpsEntries = spec.gps ?? [];

  if (!gpsEntries.length) {
    return cat(header, buildIfd(mainEntries, 8).block);
  }
  // GPS IFD の位置を確定させるため、まずIFD0の大きさを測る
  const probe = buildIfd(mainEntries, 8, [{ tag: 0x8825, target: 0 }]);
  const gpsOffset = probe.end;
  const main = buildIfd(mainEntries, 8, [{ tag: 0x8825, target: gpsOffset }]);
  if (main.end !== gpsOffset) throw new Error("IFD0の大きさが確定しない");
  const gps = buildIfd(gpsEntries, gpsOffset);
  return cat(header, main.block, gps.block);
}

/** PNGに埋め込める eXIf チャンクにする */
export function exifChunk(spec: ExifSpec): Uint8Array {
  return pngChunk("eXIf", buildExif(spec));
}

/**
 * 十進度を度分秒のRATIONAL 3組に変換する。
 * 秒は1/1000単位の分数で表し、丸め誤差を残さない。
 */
export function decimalToDmsRational(deg: number): [number, number][] {
  const abs = Math.abs(deg);
  let d = Math.floor(abs);
  const mFull = (abs - d) * 60;
  let m = Math.floor(mFull);
  let s = Math.round((mFull - m) * 60 * 1000);
  // 丸めで秒が60に達したら分へ、分が60に達したら度へ桁上げする。
  // 放置すると 35°40'60.00" のような表記になり、値としては正しくても読み手が戸惑う
  if (s >= 60000) { s -= 60000; m += 1; }
  if (m >= 60) { m -= 60; d += 1; }
  return [[d, 1], [m, 1], [s, 1000]];
}

export function gpsEntries(lat: number, lon: number): ExifEntry[] {
  return [
    { tag: 0, value: { type: "short", nums: [] } as Value }, // 後で除去される空タグ避け
    { tag: 1, value: asciiVal(lat >= 0 ? "N" : "S") },
    { tag: 2, value: rationalVal(...decimalToDmsRational(lat)) },
    { tag: 3, value: asciiVal(lon >= 0 ? "E" : "W") },
    { tag: 4, value: rationalVal(...decimalToDmsRational(lon)) },
  ].filter((e) => !(e.value.type === "short" && e.value.nums.length === 0));
}
