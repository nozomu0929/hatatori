/**
 * 静的解析の練習用にELF64バイナリを組み立てる。
 *
 * 「実行せずに中身を読む」のが rev の入口なので、
 * 生成物は readelf / objdump / strings が正しく扱える構造であることが要件。
 * 実際に走らせる想定ではない（そもそも素性の分からないバイナリは実行しない、
 * というのが最初に教えるべき作法でもある）。
 */
import { cat, utf8 } from "./forge.ts";

const VADDR = 0x400000;
const EHDR = 64, PHDR = 56, SHDR = 64;

export function u16(n: number) { return new Uint8Array([n & 255, (n >> 8) & 255]); }
export function u32(n: number) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
export function u64(n: number) { return cat(u32(n >>> 0), u32(Math.floor(n / 0x100000000))); }

export interface SectionSpec {
  name: string;
  /** SHT_PROGBITS(1) など */
  type?: number;
  /** SHF_ALLOC(2) | SHF_EXECINSTR(4) | SHF_WRITE(1) */
  flags?: number;
  data: Uint8Array;
}

export interface ElfSpec {
  /** .text に置く機械語。entry はこの先頭を指す */
  text: Uint8Array;
  /** .text 以外のセクション（.rodata など） */
  sections?: SectionSpec[];
}

/**
 * ELF64 (x86-64, LSB, EXEC) を組み立てる。
 * 構成は [ELFヘッダ][プログラムヘッダ][各セクションの中身][セクションヘッダ表]。
 */
export function buildElf64(spec: ElfSpec): Uint8Array {
  const secs: SectionSpec[] = [
    { name: ".text", type: 1, flags: 0x2 | 0x4, data: spec.text },
    ...(spec.sections ?? []),
  ];

  // セクション名文字列表(.shstrtab)を先に作る。名前のオフセットが必要になるため
  const names = ["", ...secs.map((s) => s.name), ".shstrtab"];
  const nameOffsets = new Map<string, number>();
  let strtab = cat(new Uint8Array(0)); // catの戻り型に合わせる
  for (const n of names) {
    nameOffsets.set(n, strtab.length);
    strtab = cat(strtab, utf8(n), new Uint8Array([0]));
  }

  const shnum = secs.length + 2; // NULL + 各セクション + .shstrtab
  const phnum = 1;
  let off = EHDR + PHDR * phnum;

  // 各セクションの配置を決める（16バイト境界に揃える）
  const placed = secs.map((s) => {
    off = align(off, 16);
    const p = { ...s, offset: off, addr: VADDR + off };
    off += s.data.length;
    return p;
  });
  const strtabOff = align(off, 16);
  off = strtabOff + strtab.length;
  const shoff = align(off, 8);
  const total = shoff + SHDR * shnum;

  const entry = placed[0].addr;

  const ehdr = cat(
    new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    u16(2),            // e_type = ET_EXEC
    u16(0x3e),         // e_machine = x86-64
    u32(1),            // e_version
    u64(entry),
    u64(EHDR),         // e_phoff
    u64(shoff),
    u32(0),            // e_flags
    u16(EHDR), u16(PHDR), u16(phnum),
    u16(SHDR), u16(shnum), u16(shnum - 1), // e_shstrndx = 最後
  );

  // ファイル全体を1つのPT_LOADで載せる（読み取り+実行）
  const phdr = cat(
    u32(1), u32(5),    // PT_LOAD, PF_R | PF_X
    u64(0), u64(VADDR), u64(VADDR),
    u64(total), u64(total), u64(0x1000),
  );

  // セクションヘッダ表
  const shdrs: Uint8Array[] = [new Uint8Array(SHDR)]; // 先頭はNULLセクション
  for (const p of placed) {
    shdrs.push(sectionHeader(nameOffsets.get(p.name)!, p.type ?? 1, p.flags ?? 0x2, p.addr, p.offset, p.data.length));
  }
  shdrs.push(sectionHeader(nameOffsets.get(".shstrtab")!, 3, 0, 0, strtabOff, strtab.length));

  // ここまでで決めた配置どおりに書き込む
  const out = new Uint8Array(total);
  out.set(ehdr, 0);
  out.set(phdr, EHDR);
  for (const p of placed) out.set(p.data, p.offset);
  out.set(strtab, strtabOff);
  for (let i = 0; i < shdrs.length; i++) out.set(shdrs[i], shoff + i * SHDR);
  return out;
}

function sectionHeader(nameOff: number, type: number, flags: number, addr: number, offset: number, size: number): Uint8Array {
  return cat(
    u32(nameOff), u32(type), u64(flags), u64(addr), u64(offset), u64(size),
    u32(0), u32(0), u64(16), u64(0),
  );
}

const align = (n: number, a: number) => Math.ceil(n / a) * a;

// ─────────── x86-64 の機械語を組み立てる小道具 ───────────

/** mov eax, imm32 */
export const movEax = (v: number) => cat(new Uint8Array([0xb8]), u32(v));
/** mov edi, imm32 */
export const movEdi = (v: number) => cat(new Uint8Array([0xbf]), u32(v));
/** mov edx, imm32 */
export const movEdx = (v: number) => cat(new Uint8Array([0xba]), u32(v));
/** movabs rsi, imm64 */
export const movRsi = (v: number) => cat(new Uint8Array([0x48, 0xbe]), u64(v));
/** xor edi, edi */
export const xorEdiEdi = () => new Uint8Array([0x31, 0xff]);
export const syscall = () => new Uint8Array([0x0f, 0x05]);
/** ret */
export const ret = () => new Uint8Array([0xc3]);

/** write(1, addr, len) */
export function sysWrite(addr: number, len: number): Uint8Array {
  return cat(movEax(1), movEdi(1), movRsi(addr), movEdx(len), syscall());
}
/** exit(code) */
export function sysExit(code: number): Uint8Array {
  return cat(movEax(60), code === 0 ? xorEdiEdi() : movEdi(code), syscall());
}

/**
 * mov byte [rbp-disp], imm8 の列を作る。
 * 文字列をデータ領域に置かず、コードの中で1バイトずつ組み立てる手法。
 * strings では出てこないので、初心者を最初に詰まらせる定番の作り。
 */
export function stackString(s: string, startDisp = 0x40): Uint8Array {
  const bytes = utf8(s);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const disp = (0x100 - (startDisp - i)) & 0xff; // rbp からの負のオフセット
    parts.push(new Uint8Array([0xc6, 0x45, disp, bytes[i]]));
  }
  return cat(...parts);
}
