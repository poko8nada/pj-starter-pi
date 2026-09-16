// クローンしたプロジェクトの初期化。スターターの痕跡を落とす。
//
//   node scripts/init.mjs
//
// package.json の prepare から呼ばれる（pnpm install の後）。手で実行してもよい。
//
// 何をするか:
//   スターター自身がチケットを切ってハーネスを作るので、クローンした時点では
//   そのチケットと、そこから算出された progress が残っている。
//   また product にはスターターの説明が入っている。それらを全部落として、空のプロダクト状態にする。
//
//   - チケットを両層とも消す
//   - closed の build を削除する（無くなったものを継承しても意味がない）
//   - 残った build の note を「スターターから継承」に書き換える
//   - product を空にする（name は package.json の name。goal / nongoal / build は空）
//   - progress を再計算する（チケット0件なので absent になる）
//   - spec/initialized.json を書く（2回目以降を防ぐ印）
//
// やらないこと:
//   - goal / nongoal を聞く。中身は後から build:add / build:set で書く
//   - バージョンを上げる（init は破壊的変更ではない）
//   - 過去版を触る（凍結済み）

import * as fs from 'node:fs';
import * as path from 'node:path';
import { initializeProject, isInitialized } from '../spec/lib/store.ts';

/**
 * スターター自身を表す環境変数。.env で設定され、.gitignore によりクローン先には配られない。これがあるリポジトリでは init を実行しない。
 */
const STARTER_ENV = 'PROJECT_STARTER';

/** このスクリプトの親（リポジトリのルート）。 */
const ROOT = path.resolve(import.meta.dirname, '..');

/** 利用者に原因を伝えて終わるためのエラー。 */
class InitError extends Error {}

/** 異常終了する。throw なので、呼び出し側の型も終端として扱われる。 */
function die(message) {
  throw new InitError(message);
}

/** package.json を読む。読めなければ例外が上まで抜けて、そこで報告される。 */
function readPackageJson() {
  const file = path.join(ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {unknown} error @returns {string} */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function skip(reason) {
  console.log(`init: ${reason}`);
}

/**
 * まだ init していないときの案内。
 * エラーにはしない。prepare から自動で呼ばれるので、pnpm install を止めたくない。
 *
 * 「もう一度 pnpm install すればよいのでは」と思われるので、そうならない理由を書く。
 * pnpm は node_modules が最新だと prepare を呼ばないため、2 は手動実行が要る。
 */
function adviseRename() {
  console.log('init: package.json の name がスターターのままです');
  console.log('');
  console.log('  このプロジェクトを始めるには:');
  console.log('    1. package.json の name を自分のプロジェクト名に変更する');
  console.log('    2. node scripts/init.mjs を実行する');
  console.log('');
  console.log('  2 は手動で実行してください。pnpm install を再実行しても init は走りません');
  console.log('  （pnpm は node_modules が最新だと prepare を呼ばないため）。');
  console.log('  name は product.name にも入ります。');
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'spec'))) {
    die(`init: spec/ が見つかりません（${ROOT}）`);
  }

  // スターター自身では実行しない。印の有無より先に見る。
  if (process.env[STARTER_ENV]) {
    skip(`スターター自身なので何もしません（${STARTER_ENV} が設定されています）`);
    return;
  }

  // 印があれば init 済み。pnpm install を何度実行してもここで止まる。
  if (isInitialized(ROOT)) {
    skip('既に初期化済みです');
    return;
  }

  const pkg = readPackageJson();
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  if (name === '' || name === 'project-starter') {
    adviseRename();
    return;
  }

  const result = await initializeProject(ROOT, name);
  console.log('init: プロジェクトを初期化しました');
  console.log(`  product  -> ${result.productFile}（name: ${name}）`);
  console.log(`  harness  -> ${result.harnessFile}`);
  if (result.removedBackend.length > 0) {
    console.log(`  closed の build を削除: ${result.removedBackend.join(', ')}`);
  }
  console.log(`  note を「スターターから継承」に書き換え: ${result.noteRewritten} 件`);
  console.log('  チケットは両層とも削除しました');
  console.log('');
  console.log('次にやること: product の goal / nongoal と build を書く');
  console.log('  node spec/cli/index.ts validate');
}

try {
  await main();
} catch (error) {
  if (error instanceof InitError) {
    console.error(error.message);
  } else {
    console.error('init: 失敗しました');
    console.error(describe(error));
  }
  process.exit(1);
}
