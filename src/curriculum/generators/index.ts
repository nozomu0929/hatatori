import type { Generator } from "../types.ts";
import {
  cat, utf8, makePng, makeZip, textChunk, pngChunk,
  toBase64, toBase32, toHex, rot, xorBytes,
  noisyCanvas, embedLsbBytes, embedLsbText, sizeForText,
} from "../forge.ts";
import { buildElf64, sysWrite, sysExit, stackString, ret } from "../elf-forge.ts";
import { parseElf, isElf } from "../../core/elf.ts";
import { exifChunk, gpsEntries, asciiVal } from "../exif-forge.ts";
import { findExifOffsets, parseExif } from "../../core/exif.ts";

const FILLER = [
  "この中に何か隠れているかもしれない。", "ログの断片:", "覚え書き:",
  "受信データ:", "抽出結果:", "バックアップより復元:",
];

export const GENERATORS: Generator[] = [
  // ───────────── recon ─────────────
  {
    id: "plain-text",
    skillId: "recon-strings",
    title: "そのまま書いてある",
    difficulty: 1,
    prompt: "テキストファイルです。まず開いて中身を見てください。",
    expectAnalyzers: ["recon", "flagscan"],
    async build(rng, flag) {
      const noise = Array.from({ length: 4 + rng.int(4) }, () => rng.pick(FILLER)).join("\n");
      return { filename: "note.txt", bytes: utf8(`${noise}\n${flag}\nend of file\n`) };
    },
  },
  {
    id: "binary-strings",
    skillId: "recon-strings",
    title: "バイナリの中の文字列",
    difficulty: 2,
    prompt: "開いても文字化けするファイルです。読める部分だけを取り出せますか？",
    expectAnalyzers: ["recon", "flagscan"],
    async build(rng, flag) {
      // ランダムなバイト列の中に文字列を埋める。エディタでは読めないが strings なら出る。
      // 実際のバイナリ中の文字列はヌル終端されているので、それに倣う
      const head = rng.bytes(300 + rng.int(400));
      const tail = rng.bytes(300 + rng.int(400));
      const nul = new Uint8Array([0]);
      return { filename: "dump.bin", bytes: cat(head, nul, utf8(flag), nul, tail) };
    },
  },
  {
    id: "magic-mismatch",
    skillId: "recon-magic",
    title: "拡張子が嘘をついている",
    difficulty: 2,
    prompt: "「.jpg」とありますが、本当に画像でしょうか？",
    expectAnalyzers: ["recon", "zip"],
    async build(_rng, flag) {
      // 中身はZIPなのに拡張子はjpg。拡張子ではなくマジックバイトを見る動機付け
      return { filename: "photo.jpg", bytes: makeZip([{ name: "readme.txt", data: utf8(`${flag}\n`) }]) };
    },
  },

  // ───────────── エンコーディング ─────────────
  {
    id: "b64-once",
    skillId: "enc-base64",
    title: "Base64を1回",
    difficulty: 1,
    prompt: "英数字の羅列が書かれています。何かの符号でしょうか。",
    expectAnalyzers: ["encoding"],
    async build(rng, flag) {
      return { filename: "encoded.txt", bytes: utf8(`${rng.pick(FILLER)}\n${toBase64(utf8(flag))}\n`) };
    },
  },
  {
    id: "b64-multi",
    skillId: "enc-multi",
    title: "デコードしても、まだ符号",
    difficulty: 3,
    prompt: "1回デコードしただけでは終わりません。",
    expectAnalyzers: ["encoding"],
    async build(rng, flag) {
      let s = flag;
      const rounds = 2 + rng.int(2); // 2〜3重
      for (let i = 0; i < rounds; i++) s = toBase64(utf8(s));
      return { filename: "layers.txt", bytes: utf8(`${rounds}回くるまれています。\n${s}\n`) };
    },
  },
  {
    id: "b32-or-hex",
    skillId: "enc-base32-hex",
    title: "Base64ではない符号",
    difficulty: 2,
    prompt: "使われている文字の種類をよく見てください。Base64とは違います。",
    expectAnalyzers: ["encoding"],
    async build(rng, flag) {
      // 文字種でどの符号かを見分ける練習。Base32は大文字と2-7のみ、16進は0-9a-fのみ
      const useB32 = rng.int(2) === 0;
      const body = useB32 ? toBase32(utf8(flag)) : toHex(utf8(flag));
      return { filename: useB32 ? "b32.txt" : "hexdump.txt", bytes: utf8(`${rng.pick(FILLER)}\n${body}\n`) };
    },
  },

  // ───────────── 古典暗号 ─────────────
  {
    id: "caesar",
    skillId: "crypto-caesar",
    title: "文字がずれている",
    difficulty: 1,
    prompt: "読めそうで読めない英文です。規則的にずれているだけかもしれません。",
    expectAnalyzers: ["encoding"],
    async build(rng, flag) {
      const n = 1 + rng.int(25);
      const body = rot(`the quick brown fox jumps over ${flag} and vanishes`, n);
      return { filename: "shifted.txt", bytes: utf8(`${body}\n`) };
    },
  },
  {
    id: "xor-single",
    skillId: "crypto-xor",
    title: "1バイトのXOR",
    difficulty: 2,
    prompt: "全体が同じ値でXORされているようです。鍵は何通りありますか？",
    expectAnalyzers: ["encoding"],
    async build(rng, flag) {
      const key = 1 + rng.int(255);
      const plain = utf8(`transmission start ${flag} transmission end`);
      return { filename: "cipher.bin", bytes: xorBytes(plain, key) };
    },
  },

  // ───────────── フォレンジック ─────────────
  {
    id: "png-append",
    skillId: "for-append",
    title: "画像の後ろに何かある",
    difficulty: 2,
    prompt: "普通に開ける画像です。でもファイルサイズが少し大きい気がします。",
    expectAnalyzers: ["png", "embedded"],
    async build(rng, flag) {
      const png = await makePng({ width: 24 + rng.int(24), height: 16 + rng.int(16) });
      return { filename: "picture.png", bytes: cat(png, utf8(`\n--- appended ---\n${flag}\n`)) };
    },
  },
  {
    id: "png-append-zip",
    skillId: "for-carve",
    title: "画像に埋まったZIP",
    difficulty: 3,
    prompt: "画像として正常に表示されます。中身を切り出せますか？",
    expectAnalyzers: ["png", "embedded", "zip"],
    async build(rng, flag) {
      const png = await makePng({ width: 32, height: 20 + rng.int(12) });
      const zip = makeZip([{ name: "secret.txt", data: utf8(`${flag}\n`) }]);
      return { filename: "innocent.png", bytes: cat(png, zip) };
    },
  },
  {
    id: "png-metadata",
    skillId: "for-metadata",
    title: "画像のメタデータ",
    difficulty: 2,
    prompt: "画素そのものではなく、画像に付随する情報を見てください。",
    expectAnalyzers: ["png"],
    async build(rng, flag) {
      const keys = ["Comment", "Author", "Description", "Software"];
      const png = await makePng({
        width: 20 + rng.int(20), height: 14,
        extraChunks: [textChunk(rng.pick(keys), flag)],
      });
      return { filename: "tagged.png", bytes: png };
    },
  },
  {
    id: "png-custom-chunk",
    skillId: "for-chunk",
    title: "規格にないチャンク",
    difficulty: 3,
    prompt: "PNGは決まった種類のブロックが並ぶ形式です。見慣れないものが混ざっていませんか。",
    expectAnalyzers: ["png"],
    async build(rng, flag) {
      // 1文字目が小文字＝「知らなければ無視してよい」補助チャンク。
      // だからビューアは何事もなく表示し、中身は自由に使える
      const type = rng.pick(["haTa", "seCr", "hiDe", "flAg"]);
      const png = await makePng({
        width: 24, height: 16,
        extraChunks: [pngChunk(type, utf8(flag))],
      });
      return { filename: "chunky.png", bytes: png };
    },
  },
  {
    id: "zip-nested",
    skillId: "for-zip",
    title: "書庫の中の書庫",
    difficulty: 3,
    prompt: "展開したら、また展開するものが出てきます。",
    expectAnalyzers: ["zip"],
    async build(rng, flag) {
      const depth = 2 + rng.int(2);
      let inner = makeZip([{ name: "flag.txt", data: utf8(`${flag}\n`) }]);
      for (let i = 0; i < depth; i++) {
        inner = makeZip([
          { name: `layer${depth - i}.zip`, data: inner },
          { name: "hint.txt", data: utf8("keep going\n") },
        ]);
      }
      return { filename: "matryoshka.zip", bytes: inner };
    },
  },
  // ───────────── ステガノグラフィ ─────────────
  {
    id: "png-lsb-bytes",
    skillId: "stego-lsb",
    title: "画素の最下位ビットに書かれた文字列",
    difficulty: 3,
    prompt: "ごく普通の画像に見えます。画素の値そのものではなく、その一番下の1ビットだけを見てください。",
    expectAnalyzers: ["lsb"],
    async build(rng, flag) {
      const w = 64 + rng.int(32), h = 48 + rng.int(24);
      const rgb = noisyCanvas(rng, w, h);
      // 前後に無関係な文字を置いて、単純な先頭一致では終わらないようにする
      embedLsbBytes(rgb, utf8(`hello there\n${flag}\nthat is all\n`));
      return { filename: "noise.png", bytes: await makePng({ width: w, height: h, rgb }) };
    },
  },
  {
    id: "png-lsb-visual",
    skillId: "stego-plane",
    title: "ビット面に描かれた文字",
    difficulty: 4,
    prompt: "最下位ビットだけを取り出して白黒画像にすると、何かが見えます。読み取って入力してください（大文字）。",
    // ビット面に「絵」として描かれているので、機械的な抽出では文字列にならない。
    // エンジンは画像を出すところまでで、読むのは人間の仕事。
    solvable: "assisted",
    expectStep: "最下位ビット面だけが他と食い違っている",
    flagStyle: "upper",
    expectAnalyzers: ["lsb"],
    async build(rng, flag) {
      const scale = 2;
      const { width, height } = sizeForText(flag, scale, 10);
      const rgb = noisyCanvas(rng, width, height);
      embedLsbText(rgb, width, height, flag, scale);
      return { filename: "plane.png", bytes: await makePng({ width, height, rgb }) };
    },
  },
  {
    id: "zip-encoded",
    skillId: "for-zip",
    title: "書庫の中の符号",
    difficulty: 4,
    prompt: "展開して終わりではありません。出てきたものをさらに読んでください。",
    expectAnalyzers: ["zip", "encoding"],
    async build(rng, flag) {
      const body = rng.int(2) === 0 ? toBase32(utf8(flag)) : toBase64(utf8(flag));
      const inner = makeZip([{ name: "message.txt", data: utf8(`decode this:\n${body}\n`) }]);
      return {
        filename: "bundle.zip",
        bytes: makeZip([{ name: "inner.zip", data: inner }, { name: "readme.txt", data: utf8("almost there\n") }]),
      };
    },
  },
  // ───────────── OSINT ─────────────
  {
    id: "exif-gps",
    skillId: "osint-exif",
    title: "写真に残った座標",
    difficulty: 2,
    prompt:
      "この画像がどこで撮られたか、位置情報から読み取ってください。" +
      "十進度に直して flag{緯度_経度} の形で答えます（小数第4位まで。例: flag{35.6812_139.7671}）",
    // エンジンは度分秒と換算方法までしか出さない（ヒントで答えを渡さないため）
    solvable: "assisted",
    expectStep: "GPS座標が記録されている",
    expectAnalyzers: ["exif"],
    selfCheck: coordSelfCheck,
    async build(rng, _flag) {
      const lat = pickCoord(rng, 60), lon = pickCoord(rng, 170);
      return {
        filename: "holiday.png",
        bytes: await geoPng(rng, lat, lon),
        flag: coordFlag(lat, lon),
      };
    },
  },
  {
    id: "exif-gps-signed",
    skillId: "osint-coords",
    title: "南半球・西半球の座標",
    difficulty: 3,
    prompt:
      "位置情報の参照方向（N/S、E/W）に注意してください。" +
      "十進度に直して flag{緯度_経度} の形で答えます（小数第4位まで。負の値は先頭に - を付けます）",
    solvable: "assisted",
    expectStep: "GPS座標が記録されている",
    expectAnalyzers: ["exif"],
    selfCheck: coordSelfCheck,
    async build(rng, _flag) {
      // 必ず南緯・西経のどちらか、または両方にする（符号の扱いを練習させる）
      const southern = rng.int(3) !== 0;
      const western = rng.int(3) !== 0 || !southern;
      const lat = pickCoord(rng, 55) * (southern ? -1 : 1);
      const lon = pickCoord(rng, 160) * (western ? -1 : 1);
      return {
        filename: "expedition.png",
        bytes: await geoPng(rng, lat, lon),
        flag: coordFlag(lat, lon),
      };
    },
  },
  {
    id: "exif-identity",
    skillId: "osint-trail",
    title: "撮影者をたどる",
    difficulty: 3,
    prompt:
      "写真そのものではなく、付随する情報から「誰が・いつ」を組み立ててください。" +
      "flag{撮影者名_YYYYMMDD} の形で答えます（撮影者名は記録されているまま、日付は8桁）",
    solvable: "assisted",
    expectStep: "EXIFに",
    expectAnalyzers: ["exif"],
    async build(rng, _flag) {
      const who = rng.pick(["k_yamada", "m_tanaka", "a_suzuki", "r_kobayashi", "h_watanabe"]);
      const y = 2019 + rng.int(6), mo = 1 + rng.int(12), d = 1 + rng.int(28);
      const p2 = (n: number) => String(n).padStart(2, "0");
      const stamp = `${y}:${p2(mo)}:${p2(d)} ${p2(rng.int(24))}:${p2(rng.int(60))}:${p2(rng.int(60))}`;
      const png = await makePng({
        width: 48, height: 36,
        extraChunks: [exifChunk({
          main: [
            { tag: 0x010f, value: asciiVal(rng.pick(["Canon", "NIKON CORPORATION", "SONY", "FUJIFILM"])) },
            { tag: 0x0110, value: asciiVal(rng.pick(["EOS R6", "NIKON Z 6_2", "ILCE-7M4", "X-T5"])) },
            { tag: 0x013b, value: asciiVal(who) },
            { tag: 0x0132, value: asciiVal(stamp) },
            { tag: 0x0131, value: asciiVal("darktable 4.4.2") },
          ],
        })],
      });
      return { filename: "portrait.png", bytes: png, flag: `flag{${who}_${y}${p2(mo)}${p2(d)}}` };
    },
  },
  // ───────────── リバースエンジニアリング ─────────────
  {
    id: "elf-rodata",
    skillId: "rev-static",
    title: "定数領域に残る比較対象",
    difficulty: 3,
    prompt: "Linux向けの実行ファイルです。実行はせず、中身だけを読んでください。入力を何と比べているでしょうか。",
    expectAnalyzers: ["elf"],
    async build(rng, flag) {
      const noise = [
        "Enter the license key: ", "Access denied.\n", "Access granted.\n",
        "usage: %s <key>\n", "libc-2.31.so", "GCC: (GNU) 11.2.0",
      ];
      const msgs = utf8(noise.join("\0") + "\0" + flag + "\0");
      return { filename: "keycheck", bytes: await elfWith(msgs) };
    },
  },
  {
    id: "elf-xor-rodata",
    skillId: "rev-obfuscated",
    title: "定数領域の文字列が符号化されている",
    difficulty: 4,
    prompt: "strings では何も出てきません。それでも比較対象はどこかに無いといけません。",
    expectAnalyzers: ["elf", "encoding"],
    async build(rng, flag) {
      // 実行時にXORで戻す作り。データとしては読めないが、鍵は1バイトなので総当たりで割れる
      const key = 1 + rng.int(254);
      const enc = xorBytes(utf8(flag), key);
      const msgs = cat(utf8("Enter the license key: \0Access denied.\n\0"), enc, new Uint8Array([0]));
      return { filename: "obfuscated", bytes: await elfWith(msgs) };
    },
  },
  {
    id: "elf-stack-string",
    skillId: "rev-stack",
    title: "コード中で組み立てられる文字列",
    difficulty: 5,
    prompt: "strings にも定数領域にも答えがありません。命令そのものを読む必要があります。",
    expectAnalyzers: ["elf"],
    async build(_rng, flag) {
      // 文字列をデータに置かず、mov byte 命令の即値として1バイトずつ埋める
      const msgs = utf8("Enter the license key: \0Access denied.\n\0");
      const bytes = await elfWithRodata(msgs, (addr) =>
        cat(stackString(flag), sysWrite(addr, msgs.length), sysExit(1), ret()));
      return { filename: "assembled", bytes };
    },
  },
];

/**
 * .rodata の配置アドレスはELFを組み立てた後でないと分からないが、
 * コードはそのアドレスを参照する必要がある。
 * そこで一度仮のアドレスで組んで実アドレスを測り、同じ長さのコードで組み直す。
 * makeCode の出力長がアドレスによって変わらないこと（即値は常に8バイト）が前提。
 */
async function elfWithRodata(
  rodata: Uint8Array,
  makeCode: (rodataAddr: number) => Uint8Array,
): Promise<Uint8Array> {
  const mk = (addr: number) =>
    buildElf64({ text: makeCode(addr), sections: [{ name: ".rodata", data: rodata }] });

  const probe = mk(0);
  const info = parseElf(probe);
  const addr = isElf(info) ? (info.sections.find((s) => s.name === ".rodata")?.addr ?? 0) : 0;
  const real = mk(addr);
  if (real.length !== probe.length) throw new Error("コード長がアドレスで変わった。配置を確定できない");
  return real;
}

/** 定数を表示して終了するだけの、素直な作りの実行ファイル */
function elfWith(rodata: Uint8Array): Promise<Uint8Array> {
  return elfWithRodata(rodata, (addr) => cat(sysWrite(addr, rodata.length), sysExit(0)));
}

/**
 * 出題したファイルから、学習者と同じ手順で答えを再計算して突き合わせる。
 * 度分秒への変換で精度が落ちると「正解に到達できない問題」ができてしまうため。
 */
function coordSelfCheck(inst: { bytes: Uint8Array; flag: string }): string | null {
  const offs = findExifOffsets(inst.bytes);
  if (!offs.length) return "EXIFが見つからない";
  const ex = parseExif(inst.bytes, offs[0]);
  if (!ex?.gps) return "GPS情報を読み出せない";
  const derived = coordFlag(ex.gps.lat, ex.gps.lon);
  if (derived !== inst.flag) return `EXIFから導ける答えは ${derived} で、正解 ${inst.flag} と一致しない`;
  const dms = (n: string) => ex.tags.find((t) => t.name === n)?.raw ?? [];
  for (const n of ["GPSLatitude", "GPSLongitude"]) {
    const r = dms(n);
    if (r[1] >= 60 || r[2] >= 60) return `${n} の分か秒が60以上（${r.join("/")}）。表記として不自然`;
  }
  return null;
}

/** 十進度を小数第4位で切って座標を決める。答え合わせを一意にするため桁を固定する */
function pickCoord(rng: { int(n: number): number }, maxDeg: number): number {
  return Number((rng.int(maxDeg * 10000) / 10000).toFixed(4));
}
function coordFlag(lat: number, lon: number): string {
  return `flag{${lat.toFixed(4)}_${lon.toFixed(4)}}`;
}

/** 位置情報付きの風景っぽい画像。中身より、付随する情報の方が問題になる */
async function geoPng(rng: { int(n: number): number }, lat: number, lon: number): Promise<Uint8Array> {
  const w = 56, h = 40;
  return makePng({
    width: w, height: h,
    // 空と地面だけの簡素な絵。画像そのものは手がかりではないと分かる見た目にする
    pixel: (x, y) => (y < h * 0.6
      ? [120 + rng.int(20), 170 + rng.int(20), 230]
      : [70 + rng.int(30), 120 + rng.int(30), 60]),
    extraChunks: [exifChunk({
      main: [
        { tag: 0x010f, value: asciiVal("Apple") },
        { tag: 0x0110, value: asciiVal("iPhone 14 Pro") },
        { tag: 0x0132, value: asciiVal("2024:07:21 14:03:57") },
      ],
      gps: gpsEntries(lat, lon),
    })],
  });
}

export const GENERATORS_BY_ID = new Map(GENERATORS.map((g) => [g.id, g]));
export const GENERATORS_BY_SKILL = GENERATORS.reduce((m, g) => {
  (m[g.skillId] ??= []).push(g);
  return m;
}, {} as Record<string, Generator[]>);
