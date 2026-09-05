#!/usr/bin/env node --experimental-strip-types
/**
 * ハタトリ CLI — 解析エンジンの検証ハーネス
 *
 * 使い方:
 *   node --experimental-strip-types src/cli/hatatori.ts <file> [--flags] [--quiz] [--format picoCTF{}]
 *   node --experimental-strip-types src/cli/hatatori.ts --verify   # サンプル一括検証
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { analyze } from "../core/pipeline.ts";
import { userPattern, defaultPatterns } from "../core/flag.ts";
import type { Report } from "../core/types.ts";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", mag: "\x1b[35m", blue: "\x1b[34m",
};
const GENRE_COLOR: Record<string, string> = {
  recon: C.blue, forensics: C.mag, crypto: C.cyan, stego: C.yellow, rev: C.red,
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--verify")) return verify();

  const target = argv.find((a) => !a.startsWith("--"));
  if (!target || !existsSync(target)) {
    console.error("使い方: hatatori <file> [--flags] [--quiz] [--format 'picoCTF{}']");
    process.exit(1);
  }
  const fmtIdx = argv.indexOf("--format");
  const formatSpecified = fmtIdx >= 0 && !!argv[fmtIdx + 1];
  const patterns = formatSpecified ? [userPattern(argv[fmtIdx + 1])] : defaultPatterns();

  const bytes = new Uint8Array(readFileSync(target));
  const report = await analyze(bytes, { label: basename(target), flagPatterns: patterns, formatSpecified });

  if (argv.includes("--flags")) return printFlags(report);
  if (argv.includes("--quiz")) return printQuiz(report);
  printWalkthrough(report, basename(target));
}

function printFlags(r: Report) {
  if (!r.flags.length) return console.log(`${C.dim}フラグ候補なし${C.reset}`);
  for (const f of r.flags) {
    const bar = f.confidence >= 0.85 ? C.green : f.confidence >= 0.5 ? C.yellow : C.dim;
    console.log(`${bar}${f.value}${C.reset}  ${C.dim}${(f.confidence * 100) | 0}% — ${f.where}${C.reset}`);
  }
}

/** 通常モード: 解法を最初から最後まで解説する */
function printWalkthrough(r: Report, name: string) {
  console.log(`\n${C.bold}━━ ハタトリ 解析レポート: ${name} ━━${C.reset}\n`);

  const meaningful = r.walkthrough.filter((s) => s.confidence >= 0.4);
  const shown = meaningful.length ? meaningful : r.walkthrough;

  shown.forEach((s, i) => {
    const col = GENRE_COLOR[s.genre] ?? C.reset;
    console.log(`${col}${C.bold}[${i + 1}] ${s.title}${C.reset} ${C.dim}(${s.genre} / 確度${(s.confidence * 100) | 0}%)${C.reset}`);
    console.log(`  ${C.dim}観察${C.reset}  ${indent(s.observation)}`);
    console.log(`  ${C.dim}根拠${C.reset}  ${indent(s.reasoning)}`);
    console.log(`  ${C.dim}操作${C.reset}  ${indent(s.action)}`);
    if (s.command) console.log(`  ${C.dim}手動${C.reset}  ${C.green}$ ${s.command}${C.reset}`);
    console.log(`  ${C.dim}結果${C.reset}  ${indent(s.outcome)}`);
    if (s.learn) console.log(`  ${C.yellow}補足${C.reset}  ${C.dim}${indent(s.learn)}${C.reset}`);
    console.log();
  });

  console.log(`${C.bold}━━ 抽出されたファイル構造 ━━${C.reset}`);
  printTree(r.root);
  console.log(`\n${C.bold}━━ フラグ ━━${C.reset}`);
  printFlags(r);
  console.log(`${C.dim}\n手順 ${r.walkthrough.length} 件 / ${r.elapsedMs}ms${C.reset}`);
}

/** 教材モード: 答えを伏せ、次の一手だけを段階的に示す */
function printQuiz(r: Report) {
  const key = r.walkthrough.filter((s) => s.confidence >= 0.6);
  console.log(`\n${C.bold}━━ ヒントモード ━━${C.reset}`);
  console.log(`${C.dim}この問題は ${key.length} 手で解けます。上から1つずつ試してください。${C.reset}\n`);
  key.forEach((s, i) => {
    console.log(`${C.yellow}ヒント${i + 1}${C.reset} ${s.observation.split("\n")[0]}`);
    console.log(`  ${C.dim}${s.reasoning.slice(0, 90)}…${C.reset}`);
    if (s.command) console.log(`  ${C.dim}使うコマンド: ${s.command.split("#")[0].trim()}${C.reset}`);
    console.log();
  });
  console.log(`${C.dim}答えを見るには --flags を付けて実行${C.reset}`);
}

function printTree(n: any, prefix = "", connector = "", childPrefix = "") {
  console.log(`${prefix}${connector}${C.cyan}${n.label}${C.reset} ${C.dim}[${n.kind.label}, ${n.bytes.length}B]${C.reset}`);
  n.children.forEach((c: any, i: number) => {
    const last = i === n.children.length - 1;
    printTree(c, childPrefix, last ? "└─ " : "├─ ", childPrefix + (last ? "   " : "│  "));
  });
}

function indent(s: string): string {
  return s.split("\n").join("\n        ");
}

/** サンプル一括検証。エンジンの正解率をここで測る */
async function verify() {
  const dir = fileURLToPath(new URL("../../samples/out/", import.meta.url));
  const cases = JSON.parse(readFileSync(dir + "answers.json", "utf8"));
  let pass = 0;
  console.log(`\n${C.bold}━━ 検証: ${cases.length} 問 ━━${C.reset}\n`);

  for (const c of cases) {
    const bytes = new Uint8Array(readFileSync(dir + c.file));
    const t0 = Date.now();
    const r = await analyze(bytes, { label: c.file });
    const ms = Date.now() - t0;
    const top = r.flags[0]?.value ?? "";
    const found = r.flags.some((f) => f.value === c.answer);
    const ok = c.answer ? found : r.flags.length === 0;
    if (ok) pass++;

    const mark = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    const rank = c.answer && found && r.flags.findIndex((f) => f.value === c.answer) !== 0 ? `${C.yellow} (1位ではない)${C.reset}` : "";
    console.log(`${mark} ${c.file.padEnd(16)} ${C.dim}${c.teaches.padEnd(28)}${C.reset} ${ms}ms${rank}`);
    if (!ok) console.log(`   ${C.dim}期待: ${c.answer || "(なし)"} / 実際: ${top || "(なし)"} 候補${r.flags.length}件${C.reset}`);
  }
  const rate = ((pass / cases.length) * 100).toFixed(0);
  console.log(`\n${pass === cases.length ? C.green : C.yellow}${pass}/${cases.length} 正解 (${rate}%)${C.reset}\n`);
  if (pass !== cases.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
