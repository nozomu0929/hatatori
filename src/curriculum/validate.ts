/**
 * 教材の検証。
 *
 * 生成した問題を実際に解析エンジンにかけ、
 *   (1) フラグに到達できるか
 *   (2) 想定した筋道（アナライザ）を通ったか
 * の両方を確かめる。
 *
 * (2)まで見るのは、たとえフラグが出ても違う経路で出たのなら、
 * その問題は狙った考え方を練習させていないため。
 * 教材と実装が食い違ったまま気づかない事態を防ぐ。
 */
import { analyze } from "../core/pipeline.ts";
import { instantiate, lintCurriculum, orderedSkills } from "./index.ts";
import { GENERATORS } from "./generators/index.ts";
import { LEVEL_LABEL, isPlayable } from "./types.ts";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

export interface CaseResult {
  generatorId: string; seed: number; ok: boolean;
  found: boolean; ranked1: boolean; missingAnalyzers: string[];
  flag: string; top: string; ms: number;
  assisted: boolean; evidenceOk: boolean; selfIssue: string | null;
}

export async function validateGenerator(id: string, seeds: number[]): Promise<CaseResult[]> {
  const gen = GENERATORS.find((g) => g.id === id)!;
  const out: CaseResult[] = [];
  for (const seed of seeds) {
    const inst = await instantiate(id, seed);
    const t0 = Date.now();
    const report = await analyze(inst.bytes, { label: inst.filename });
    const ms = Date.now() - t0;
    const found = report.flags.some((f) => f.value === inst.flag);
    const ranked1 = report.flags[0]?.value === inst.flag;
    const used = new Set(report.walkthrough.map((s) => s.analyzer));
    const missing = gen.expectAnalyzers.filter((a) => !used.has(a));
    // assisted の問題はエンジンがフラグまで到達しない。
    // 代わりに「人間が読むための手がかりを必ず出したか」を検査する。
    const assisted = gen.solvable === "assisted";
    const evidenceOk = !gen.expectStep || report.walkthrough.some((s) => s.title.includes(gen.expectStep!));
    // 内容そのものの正しさ（答えに到達できるか）は別途検査する
    const selfIssue = gen.selfCheck ? gen.selfCheck(inst) : null;
    out.push({
      generatorId: id, seed,
      ok: (assisted ? evidenceOk : found && ranked1) && missing.length === 0 && !selfIssue,
      selfIssue,
      found, ranked1, missingAnalyzers: missing, flag: inst.flag,
      top: report.flags[0]?.value ?? "(なし)", ms,
      assisted, evidenceOk,
    });
  }
  return out;
}

export async function main() {
  console.log(`\n${C.bold}━━ スキルツリーの整合性 ━━${C.reset}`);
  const errs = lintCurriculum();
  if (errs.length) {
    for (const e of errs) console.log(`${C.red}✗${C.reset} ${e}`);
  } else {
    console.log(`${C.green}✓${C.reset} 問題なし`);
  }

  const skills = orderedSkills();
  const playable = skills.filter(isPlayable);
  console.log(`\n${C.bold}━━ 学習経路 ━━${C.reset}`);
  for (const s of skills) {
    const tag = isPlayable(s) ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
    const req = s.requires.length ? `${C.dim} ← ${s.requires.join(", ")}${C.reset}` : "";
    const n = s.generators.length ? `${C.dim}(問題${s.generators.length})${C.reset}` : `${C.dim}(未実装)${C.reset}`;
    console.log(`${tag} ${C.dim}Lv${s.level} ${LEVEL_LABEL[s.level].padEnd(5)}${C.reset} ${C.cyan}${s.id.padEnd(18)}${C.reset} ${s.title.padEnd(20)} ${n}${req}`);
  }

  // 問題は生成物なので、種を増やせばそのままファジングになる。
  // 手で問題を用意していたら得られない検証量が、ただで手に入る。
  const nArg = process.argv.indexOf("--seeds");
  const n = nArg >= 0 ? Number(process.argv[nArg + 1]) : 5;
  const SEEDS = Array.from({ length: n }, (_, i) => (i * 2654435761 + 1) >>> 0);
  console.log(`\n${C.bold}━━ 問題生成の検証（各${SEEDS.length}種の乱数で生成し、実際に解かせる）━━${C.reset}\n`);
  let pass = 0, total = 0;
  for (const gen of GENERATORS) {
    const rs = await validateGenerator(gen.id, SEEDS);
    const ok = rs.filter((r) => r.ok).length;
    pass += ok; total += rs.length;
    const mark = ok === rs.length ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    const avg = Math.round(rs.reduce((s, r) => s + r.ms, 0) / rs.length);
    const kind = gen.solvable === "assisted" ? `${C.dim}[要目視]${C.reset}` : "";
    console.log(`${mark} ${gen.id.padEnd(18)} ${C.dim}${gen.skillId.padEnd(18)}${C.reset} ${ok}/${rs.length} ${C.dim}平均${avg}ms${C.reset} ${kind}`);
    for (const r of rs.filter((x) => !x.ok)) {
      const why = [
        r.selfIssue,
        r.assisted && !r.evidenceOk ? "手がかりの手順が出ていない" : null,
        !r.assisted && !r.found ? "フラグ未検出" : null,
        !r.assisted && r.found && !r.ranked1 ? `1位でない(1位は ${r.top})` : null,
        r.missingAnalyzers.length ? `未通過: ${r.missingAnalyzers.join(",")}` : null,
      ].filter(Boolean).join(" / ");
      console.log(`   ${C.yellow}seed=${r.seed}${C.reset} ${C.dim}${why}｜正解 ${r.flag}${C.reset}`);
    }
  }
  const rate = ((pass / total) * 100).toFixed(0);
  console.log(`\n${pass === total ? C.green : C.yellow}${pass}/${total} 合格 (${rate}%)${C.reset}`);
  console.log(`${C.dim}スキル ${playable.length} 個が学習可能、${skills.length - playable.length} 個が構想段階${C.reset}\n`);
  if (errs.length || pass !== total) process.exitCode = 1;
}

main();
