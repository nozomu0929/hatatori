import type { Instance, Skill, Progress } from "./types.ts";
import { RNG, randomSeed, makeFlag } from "./rng.ts";
import { GENERATORS_BY_ID } from "./generators/index.ts";
import { SKILLS, SKILLS_BY_ID } from "./skills.ts";

export * from "./types.ts";
export { SKILLS, SKILLS_BY_ID } from "./skills.ts";
export { GENERATORS, GENERATORS_BY_ID, GENERATORS_BY_SKILL } from "./generators/index.ts";
export { RNG, randomSeed, makeFlag } from "./rng.ts";

/** 問題を1つ作る。種を渡さなければ毎回別の問題になる */
export async function instantiate(generatorId: string, seed = randomSeed(), prefix = "flag"): Promise<Instance> {
  const gen = GENERATORS_BY_ID.get(generatorId);
  if (!gen) throw new Error(`未知の生成器: ${generatorId}`);
  const rng = new RNG(seed);
  const flag = makeFlag(rng, prefix, gen.flagStyle ?? "lower");
  const built = await gen.build(rng, flag);
  return {
    generatorId, seed,
    filename: built.filename,
    bytes: built.bytes,
    // 生成物から答えが決まる問題（座標など）では build 側の値を採用する
    flag: built.flag ?? flag,
    prompt: gen.prompt,
  };
}

/** スキルツリーをレベル順・依存順に並べる */
export function orderedSkills(): Skill[] {
  const out: Skill[] = [];
  const done = new Set<string>();
  const rest = [...SKILLS];
  // 前提を満たしたものから順に並べる（依存の浅い順）
  while (rest.length) {
    const ready = rest.filter((s) => s.requires.every((r) => done.has(r)));
    if (!ready.length) { out.push(...rest); break; } // 循環があれば残りをそのまま出す
    ready.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
    for (const s of ready) {
      out.push(s);
      done.add(s.id);
      rest.splice(rest.indexOf(s), 1);
    }
  }
  return out;
}

/** スキルツリーの整合性を確かめる。内容を書き足したときの取りこぼしを防ぐ */
export function lintCurriculum(): string[] {
  const errs: string[] = [];
  for (const s of SKILLS) {
    for (const r of s.requires) {
      if (!SKILLS_BY_ID.has(r)) errs.push(`${s.id}: 前提スキル "${r}" が存在しない`);
      else if (SKILLS_BY_ID.get(r)!.level > s.level) errs.push(`${s.id}(Lv${s.level}): 前提 "${r}" の方が高レベル(Lv${SKILLS_BY_ID.get(r)!.level})`);
    }
    for (const g of s.generators) {
      if (!GENERATORS_BY_ID.has(g)) errs.push(`${s.id}: 生成器 "${g}" が存在しない`);
      else if (GENERATORS_BY_ID.get(g)!.skillId !== s.id) errs.push(`${s.id}: 生成器 "${g}" のskillIdが一致しない`);
    }
    if (s.status !== "planned" && s.generators.length === 0) errs.push(`${s.id}: 練習問題が無いのに planned が付いていない`);
    if (s.concept.commands.length === 0) errs.push(`${s.id}: commands が空（手作業の道を必ず示すこと）`);
    if (s.concept.pitfalls.length === 0) errs.push(`${s.id}: pitfalls が空`);
  }
  // 循環参照の検出
  for (const s of SKILLS) {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (seen.has(id)) return true;
      seen.add(id);
      return (SKILLS_BY_ID.get(id)?.requires ?? []).some(walk);
    };
    if (s.requires.some(walk)) errs.push(`${s.id}: 前提スキルが循環している`);
  }
  return errs;
}

/** localStorage への保存・読み出し（ブラウザ以外では何もしない） */
const KEY = "hatatori.progress.v1";
export function loadProgress(): Progress {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) return JSON.parse(raw) as Progress;
  } catch { /* プライベートモード等では読めないことがある。既定値で続行する */ }
  return { solved: {}, hintsUsed: {}, updatedAt: Date.now() };
}
export function saveProgress(p: Progress): void {
  try {
    p.updatedAt = Date.now();
    globalThis.localStorage?.setItem(KEY, JSON.stringify(p));
  } catch { /* 保存できなくても学習は続けられる。失敗は握りつぶす */ }
}
