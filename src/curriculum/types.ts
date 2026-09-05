import type { Genre } from "../core/types.ts";
import type { RNG } from "./rng.ts";

export type Level = 0 | 1 | 2 | 3 | 4;

export const LEVEL_LABEL: Record<Level, string> = {
  0: "超初心者", 1: "入門", 2: "初級", 3: "中級", 4: "上級",
};

/**
 * スキルツリーのノード。1ノード＝1つの考え方。
 * ツールの使い方ではなく「なぜその手を打つのか」を単位にする。
 */
export interface Skill {
  id: string;
  genre: Genre;
  level: Level;
  title: string;
  /** 一行で言うと何を身につけるのか */
  summary: string;
  /** 前提スキル。全て終えるまで開かない */
  requires: string[];
  concept: Concept;
  /** このスキルの練習問題（生成器のid）。空なら未実装 */
  generators: string[];
  /** 構想はあるが練習問題がまだ無いものを、道筋として見せるための印 */
  status?: "planned";
}

/** 読み物パート。解析エンジンのStep.reasoning / learn と同じ思想で書く */
export interface Concept {
  /** なぜこの手法が成立するのか。仕組みの説明 */
  why: string;
  /** どう使うのか。手順の説明 */
  how: string;
  /** 覚えるべきコマンド。ツール非依存の技能にするため必ず添える */
  commands: { cmd: string; what: string }[];
  /** つまずきどころ。初心者が実際にはまる箇所を書く */
  pitfalls: string[];
}

/** 生成された問題1つ分 */
export interface Instance {
  generatorId: string;
  seed: number;
  filename: string;
  bytes: Uint8Array;
  /** 正解。検証と答え合わせに使う */
  flag: string;
  prompt: string;
}

/**
 * 問題生成器。
 * 問題をその場で作ることで、素材の権利処理・配信・答えの流出を同時に回避する。
 */
export interface Generator {
  id: string;
  skillId: string;
  title: string;
  /** 1〜5。同じスキル内での相対的な歯ごたえ */
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** 問題文。ファイル以外の手がかりを与えたいときに使う */
  prompt: string;
  /**
   * 解析エンジンだけで答えまで到達できるか。
   *   auto     … エンジンがフラグ文字列を取り出せる
   *   assisted … エンジンは手がかり（例: ビット面の画像）までしか出せず、
   *              最後は人間が目で読む必要がある
   * ステガノの「見て読む」型はassistedになる。ここを区別しないと、
   * 検証が「フラグに到達できない＝不合格」と誤判定してしまう。
   */
  solvable?: "auto" | "assisted";
  /** assisted の場合に、エンジンが必ず出すべき手順の見出し（部分一致で検査） */
  expectStep?: string;
  /**
   * 生成した問題から、想定の手順で本当に答えへ到達できるかを自己検査する。
   * 問題なければ null、駄目なら理由を返す。
   *
   * 座標問題のように「答えが生成物から計算される」場合、
   * 丸め誤差ひとつで到達不能な問題ができてしまう。
   * エンジンが手順を出したかどうかとは別に、ここで内容の正しさを担保する。
   */
  selfCheck?(inst: Instance): string | null;
  /** フラグの字種。画像に描く問題は大文字のみのフォントを使うため upper にする */
  flagStyle?: "lower" | "upper";
  /**
   * 問題ファイルを作る。
   * 通常は渡された flag を埋め込むが、座標問題のように
   * 「答えが生成物から決まる」場合は flag を返して上書きできる。
   */
  build(rng: RNG, flag: string): Promise<{ filename: string; bytes: Uint8Array; flag?: string }>;
  /**
   * この問題を解く過程で必ず通るはずのアナライザ。
   * 検証時に「エンジンが想定通りの筋道で解いたか」を確かめる。
   * フラグが出ても筋道が違えば教材として破綻しているので、そこまで見る。
   */
  expectAnalyzers: string[];
}

/** 学習の進み具合。端末内(localStorage)に保存する */
export interface Progress {
  /** 解いたスキルid → 正解した問題数 */
  solved: Record<string, number>;
  /** 開封したヒントの数（多用しても罰しないが、記録は残す） */
  hintsUsed: Record<string, number>;
  updatedAt: number;
}

export function isUnlocked(skill: Skill, progress: Progress): boolean {
  return skill.requires.every((r) => (progress.solved[r] ?? 0) > 0);
}

export function isPlayable(skill: Skill): boolean {
  return skill.status !== "planned" && skill.generators.length > 0;
}

/** 前提を満たしていて、まだ解いていないスキル＝いま取り組むべきもの */
export function nextSkills(skills: Skill[], progress: Progress): Skill[] {
  return skills
    .filter((s) => isPlayable(s) && isUnlocked(s, progress) && !(progress.solved[s.id] > 0))
    .sort((a, b) => a.level - b.level);
}

export function emptyProgress(): Progress {
  return { solved: {}, hintsUsed: {}, updatedAt: Date.now() };
}
