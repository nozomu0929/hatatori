/** 既知の答えを持つ検証用CTF問題を生成する。解析エンジンの正解率測定に使う */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32 } from "../src/core/crc32.ts";

const OUT = fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const enc = new TextEncoder();

function cat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const o = new Uint8Array(n); let p = 0;
  for (const x of parts) { o.set(x, p); p += x.length; }
  return o;
}
function be32(n: number) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function le32(n: number) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
function le16(n: number) { return new Uint8Array([n & 255, (n >>> 8) & 255]); }

async function deflate(b: Uint8Array, fmt: "deflate" | "deflate-raw"): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream(fmt));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const td = cat(enc.encode(type), data);
  return cat(be32(data.length), td, be32(crc32(td)));
}

async function makePng(w: number, h: number, extraChunks: Uint8Array[] = []): Promise<Uint8Array> {
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = (x * 7) & 255;
      raw[row + 2 + x * 3] = (y * 11) & 255;
      raw[row + 3 + x * 3] = 0x40;
    }
  }
  const ihdr = cat(be32(w), be32(h), new Uint8Array([8, 2, 0, 0, 0]));
  return cat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extraChunks,
    chunk("IDAT", await deflate(raw, "deflate")),
    chunk("IEND", new Uint8Array(0)),
  );
}

/** 無圧縮ZIPを組み立てる */
function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nm = enc.encode(f.name);
    const c = crc32(f.data);
    const local = cat(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]), le16(20), le16(0), le16(0),
      le16(0), le16(0), le32(c), le32(f.data.length), le32(f.data.length),
      le16(nm.length), le16(0), nm, f.data,
    );
    centrals.push(cat(
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]), le16(20), le16(20), le16(0), le16(0),
      le16(0), le16(0), le32(c), le32(f.data.length), le32(f.data.length),
      le16(nm.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), nm,
    ));
    locals.push(local);
    offset += local.length;
  }
  const cd = cat(...centrals);
  const eocd = cat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]), le16(0), le16(0),
    le16(files.length), le16(files.length), le32(cd.length), le32(offset), le16(0),
  );
  return cat(...locals, cd, eocd);
}

const cases: { file: string; answer: string; teaches: string }[] = [];
function emit(file: string, data: Uint8Array, answer: string, teaches: string) {
  writeFileSync(OUT + file, data);
  cases.push({ file, answer, teaches });
}

// 1. 画像末尾にZIPを連結（最頻出パターン）
const zip1 = makeZip([{ name: "secret.txt", data: enc.encode("congrats!\nflag{append3d_z1p_af7er_1end}\n") }]);
emit("appended.png", cat(await makePng(24, 16), zip1), "flag{append3d_z1p_af7er_1end}",
     "IEND以降の余剰データ → ZIP展開");

// 2. PNGのtEXtチャンクに隠す
emit("metadata.png", await makePng(20, 12, [chunk("tEXt", cat(enc.encode("Comment"), new Uint8Array([0]), enc.encode("flag{hidden_1n_p1ng_metadata}")))]),
     "flag{hidden_1n_p1ng_metadata}", "tEXtチャンクのメタデータ");

// 3. 二重Base64
const inner = btoa("flag{d0uble_enc0ded_base64}");
emit("double_b64.txt", enc.encode("Can you decode this?\n" + btoa(inner) + "\n"),
     "flag{d0uble_enc0ded_base64}", "多重Base64 → 再帰デコード");

// 4. ROT13
const rot13 = (s: string) => s.replace(/[a-zA-Z]/g, (c) => {
  const b = c <= "Z" ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
});
emit("rot13.txt", enc.encode("Vs lbh pna ernq guvf:\n" + rot13("flag{caesar_st1ll_w0rks}") + "\n"),
     "flag{caesar_st1ll_w0rks}", "ROT13 総当たり");

// 5. 単一バイトXOR
const plain = enc.encode("The secret is flag{x0r_1s_n0t_encrypt10n} keep it safe");
const xored = new Uint8Array(plain.length);
for (let i = 0; i < plain.length; i++) xored[i] = plain[i] ^ 0x5a;
emit("xor5a.bin", xored, "flag{x0r_1s_n0t_encrypt10n}", "単一バイトXOR 総当たり");

// 6. 入れ子ZIP + Base32
const b32 = (s: string) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; const by = enc.encode(s);
  let out = "", buf = 0, bits = 0;
  for (const v of by) { buf = (buf << 8) | v; bits += 8; while (bits >= 5) { bits -= 5; out += A[(buf >> bits) & 31]; } }
  if (bits) out += A[(buf << (5 - bits)) & 31];
  while (out.length % 8) out += "=";
  return out;
};
const innerZip = makeZip([{ name: "note.txt", data: enc.encode("decode me: " + b32("flag{n3sted_z1p_and_base32}")) }]);
emit("nested.zip", makeZip([{ name: "level2.zip", data: innerZip }, { name: "readme.txt", data: enc.encode("keep digging") }]),
     "flag{n3sted_z1p_and_base32}", "入れ子ZIP → Base32");

// 7. 平文（最も簡単な対照群）
emit("plain.txt", enc.encode("welcome\nflag{just_read_the_file}\n"), "flag{just_read_the_file}", "平文grep");

// 8. フラグ無し（誤検出の検査用）
emit("nothing.bin", crypto.getRandomValues(new Uint8Array(4096)), "", "誤検出しないこと");

writeFileSync(OUT + "answers.json", JSON.stringify(cases, null, 2));
console.log(`生成: ${cases.length} 件 → ${OUT}`);
for (const c of cases) console.log(`  ${c.file.padEnd(16)} ${c.answer || "(フラグ無し)"}`);
