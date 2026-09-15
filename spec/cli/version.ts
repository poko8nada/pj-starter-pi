import { fail, type Options } from './args.ts';
import {
  currentVersion,
  formatVersion,
  listVersions,
  readSpec,
  specTypeDir,
  writeSpec,
  type Build,
} from '../lib/spec.ts';
import {
  computeProgressFor,
  loadSnapshot,
  removalBlockers,
  syncProgress,
  type Snapshot,
} from '../lib/store.ts';
import { load, printSpec, withSnapshot } from './shared.ts';

// バージョンそのものを扱うコマンド。build の個別操作は build.ts にある。

async function runValidate(options: Options): Promise<void> {
  const versions =
    options.version === undefined
      ? await listVersions(options.root, options.specType)
      : [options.version];
  if (versions.length === 0) {
    fail(`${specTypeDir(options.root, options.specType)} にバージョンファイルがありません`);
  }
  const current = await currentVersion(options.root, options.specType);

  // 同時実行はしない。1件目で落ちたときに残りを無駄に読まないため順序を保つ。
  const results: string[] = [];
  for (const version of versions) {
    // oxlint-disable-next-line no-await-in-loop -- 検証は順序よく、失敗は即中断する
    await validateVersion(options, version, version === current);
    results.push(`ok  ${options.specType}/${formatVersion(version)}`);
  }
  for (const line of results) {
    console.log(line);
  }
}

/**
 * 1バージョンを検証する。
 * 過去版は読み込んで形を確かめるだけ。progress はその時点のスナップショットなので、今のチケットと一致するはずがなく、突き合わせると常に落ちる。
 * 現行版だけ cross-document の検証（progress の突き合わせ、targets の参照解決、working の被覆）を行う。
 */
async function validateVersion(
  options: Options,
  version: number,
  isCurrentVersion: boolean,
): Promise<void> {
  if (!isCurrentVersion) {
    await readSpec(options.root, options.specType, version);
    return;
  }
  await withSnapshot(options, () => undefined);
}

async function runShow(options: Options): Promise<void> {
  const { version, spec } = await load(options);
  printSpec(spec, options, version);
}

/**
 * progress をチケットから再計算して書き戻す。
 *
 * ハーネスをスターターから適用した直後、あるいはフォーク直後に使う。
 * どちらも「チケットと spec の対応を取り直す」という同じ仕事をする外部の操作で、そのあと progress とチケットがずれた状態になる。
 */
async function runSyncProgress(options: Options): Promise<void> {
  const version = await syncProgress(options.root, options.specType);
  console.log(`synced progress ${options.specType}/${formatVersion(version)}`);
}

/**
 * 次バージョンを作る。番号は現行+1で、引数では指定しない。
 * build は引き継ぐ。破壊的変更は「一部を変える」ことであって「全部消す」ことではない。
 *
 * closed の build はここで落とす（build リストが縮む唯一の瞬間）。
 * ただし他から参照されているものは残す。参照が切れた状態で履歴に入れたくないため。
 * 自動で触るのは closed だけで、planned / building / working / retiring は残す。
 *
 * progress は引き継がず、新バージョンの数え方で置き直す。progress の算出元はバージョンに属さないチケットなので、引き継ぐと必ずずれる（v001 では正しい値がv002 では嘘になる）。新バージョンの archive はまだ無いので、open だけで数える。
 *
 * bump で切った後、前バージョンの archive は読まれない。rename や remove も現行の archive にしか届かない。これは「現行版とチケットが整合しているか」を常に検証できるようにするための割り切りで、前バージョンの記録はそのまま残す（v001 時点では page-home だった、という事実として）。
 */
async function runBump(options: Options): Promise<void> {
  const snapshot = await loadSnapshot(options.root, options.specType);
  const version = snapshot.version;
  const next = version + 1;

  const dropped: string[] = [];
  const keptClosed: { id: string; blockers: string[] }[] = [];
  const kept: Build[] = [];
  for (const build of snapshot.spec.build) {
    if (build.status !== 'closed') {
      kept.push(build);
      continue;
    }
    const blockers = removalBlockers(snapshot, build.id);
    if (blockers.length > 0) {
      keptClosed.push({ id: build.id, blockers });
      kept.push(build);
      continue;
    }
    dropped.push(build.id);
  }

  // 新バージョンの archive はまだ無いので、open だけで数える。
  // これが「v002 を切った直後の v002 の progress」そのもの。
  const progress = computeProgressFor(kept, snapshot.open, []);
  const rebuilt = kept.map((build) => {
    const { progress: _stale, ...rest } = build;
    const value = progress.get(build.id);
    return value === undefined ? rest : Object.assign(rest, { progress: value });
  });

  const file = await writeSpec(options.root, options.specType, next, {
    ...snapshot.spec,
    build: rebuilt,
  });
  console.log(
    `created ${file} (from ${formatVersion(version)}, ${rebuilt.length} builds carried over)`,
  );
  // 静かに消えないことが大事。何を落として何を残したかを必ず出す。
  if (dropped.length > 0) {
    console.log(`  dropped (closed): ${dropped.join(', ')}`);
  }
  for (const entry of keptClosed) {
    console.log(`  kept closed (still referenced): ${entry.id} <- ${entry.blockers.join(', ')}`);
  }
}

export { runBump, runShow, runSyncProgress, runValidate };
export type { Snapshot };
