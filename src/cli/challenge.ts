#!/usr/bin/env node --experimental-strip-types
/**
 * 問題を1つ生成してファイルに書き出す。
 * 作問の確認や、生成されたファイルが実際のビューアで開けるかの検証に使う。
 *
 *   npm run challenge -- png-append-zip 12345
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { instantiate, GENERATORS, SKILLS_BY_ID } from "../curriculum/index.ts";

const [id, seedArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!id) {
  console.log("使い方: npm run challenge -- <生成器id> [seed]\n");
  console.log("利用できる生成器:");
  for (const g of GENERATORS) {
    const skill = SKILLS_BY_ID.get(g.skillId);
    console.log(`  ${g.id.padEnd(18)} 難度${g.difficulty}  ${g.title.padEnd(22)} [${skill?.title ?? g.skillId}]`);
  }
  process.exit(0);
}

const seed = seedArg ? Number(seedArg) : undefined;
const inst = await instantiate(id, seed);
const dir = "challenges/";
mkdirSync(dir, { recursive: true });
const path = dir + inst.filename;
writeFileSync(path, inst.bytes);

console.log(`生成: ${path}（${inst.bytes.length} バイト, seed=${inst.seed}）`);
console.log(`問題: ${inst.prompt}`);
console.log(`答え: ${inst.flag}`);
console.log(`\n解かせる: npm run solve -- ${path}`);
