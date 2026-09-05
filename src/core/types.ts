/**
 * ハタトリ / 中核データモデル
 *
 * 設計方針:
 *   本ツールは「フラグを出す」ものではなく「解く過程を説明する」ものである。
 *   したがって全アナライザは結果(Flag)ではなく思考の跡(Step)を第一級で返す。
 *   Step は 観察→根拠→操作→結果 の4点セットで構成され、
 *   手で解く場合の実コマンド(command)を必ず併記して技能の移転を狙う。
 */

export type Genre =
  | "recon"      // 種別判定・全体観察
  | "forensics"  // ファイル構造・隠蔽データ
  | "stego"      // 画像/音声の埋め込み
  | "crypto"     // 暗号・エンコーディング
  | "rev"        // 実行ファイル解析
  | "web"
  | "osint"
  | "geo"
  | "misc";

/** 解析の一手。教材モードではこれが1枚のカードとして提示される。 */
export interface Step {
  id: string;
  analyzer: string;
  genre: Genre;
  /** 見出し: 「PNGのIEND以降に余剰データ」 */
  title: string;
  /** 観察: 客観的に何が見えたか。主観を混ぜない */
  observation: string;
  /** 根拠: なぜそれが手がかりなのか。ここが教材の本体 */
  reasoning: string;
  /** 操作: それを受けて何をしたか */
  action: string;
  /** 手作業でやる場合の等価コマンド。実務スキルへの橋渡し */
  command?: string;
  /** 結果 */
  outcome: string;
  /** 0..1 この手がかりの確からしさ */
  confidence: number;
  /** 背景知識の一言解説(初心者向け) */
  learn?: string;
  /**
   * 手順に添える画像。ステガノでは「ビット面を見せる」ことが説明の本体になる。
   * data URL にしてあるので Worker からそのまま渡せる。
   */
  attachments?: { label: string; pngDataUrl: string }[];
}

/** フラグ候補 */
export interface FlagHit {
  value: string;
  /** 発見場所の人間可読な説明 */
  where: string;
  /** ルートからの経路: ["chal.png", "IEND以降の埋め込みZIP", "secret.txt"] */
  path: string[];
  confidence: number;
  /** どの手順で見つかったか */
  viaStepId: string;
}

/** 解析対象。抽出された子ファイルも同じ型で再帰的に扱う */
export interface ArtifactNode {
  /** ルートからの経路 */
  path: string[];
  label: string;
  bytes: Uint8Array;
  kind: FileKind;
  steps: Step[];
  children: ArtifactNode[];
}

export interface FileKind {
  id: string;          // "png" | "zip" | "elf" | "text" | "unknown"
  label: string;       // "PNG画像"
  mime?: string;
  ext?: string;
  /** 判定の根拠(教材で見せる) */
  evidence?: string;
}

/** アナライザが新たに掘り出した派生データ(埋め込みファイル、復号結果など) */
export interface Derived {
  label: string;
  bytes: Uint8Array;
  /** 由来のStep id */
  fromStepId: string;
  /** 再帰解析にかけるか。復号テキストなど自明なものは false */
  recurse: boolean;
}

export interface AnalyzerResult {
  steps: Step[];
  derived: Derived[];
  flags: FlagHit[];
}

export interface Ctx {
  node: ArtifactNode;
  /** フラグ書式(例: /picoCTF\{[^}]+\}/)。未指定なら汎用パターン */
  flagPatterns: RegExp[];
  /** ユーザーがフラグ書式を明示したか。総当たり結果を信用してよいかの判断に使う */
  formatSpecified: boolean;
  /** 深すぎる再帰を止める */
  depth: number;
  maxDepth: number;
  /** id採番 */
  nextId: () => string;
  /**
   * 「このバイト範囲は自分が説明した」と申告する。
   * 例: ZIPアナライザが書庫全体を読み切ったら、その範囲を申告しておく。
   * これにより後続の埋め込み走査が、正規の構造の一部を
   * 「隠しファイル発見」と誤って報告するのを防ぐ。
   */
  claim: (start: number, end: number, by: string) => void;
  isClaimed: (offset: number) => string | null;
}

export interface Analyzer {
  name: string;
  genre: Genre;
  /** 適用可否。安いチェックのみ行うこと */
  applies(ctx: Ctx): boolean;
  run(ctx: Ctx): AnalyzerResult | Promise<AnalyzerResult>;
}

export interface Report {
  root: ArtifactNode;
  flags: FlagHit[];
  /** 時系列に平坦化した解説。これをそのまま読めば解法になる */
  walkthrough: Step[];
  elapsedMs: number;
}
