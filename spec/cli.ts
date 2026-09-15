import { DocumentError, messageOf } from './document.ts';
import {
  assertCandidateAcceptable,
  assertTransition,
  fail,
  has,
  parseOptions,
  readId,
  readState,
  readUses,
  readVerify,
  requireValue,
  single,
  type Options,
} from './args.ts';
import {
  BUILD_ID_HINT,
  BUILD_STATES,
  currentVersion,
  formatVersion,
  listVersions,
  readSpec,
  specTypeDir,
  writeSpec,
  type Build,
  type Spec,
} from './schema.ts';
import { runTicketAdd, runTicketList, runTicketRemove, runTicketSet } from './ticket-cli.ts';
import {
  computeProgressFor,
  loadSnapshot,
  persist,
  removalBlockers,
  renameBuildInTickets,
  throwIfIssues,
  type Snapshot,
} from './store.ts';
import { ticketsFile } from './ticket.ts';

// spec/ の CLI。JSON の読み書きは各ドキュメントの関数だけを通す。
// ここには「引数の解釈」「遷移の制約」「表示」以外を書かない。

const USAGE = `spec - spec/ の JSON を検証・更新する

使い方:
  node spec/cli.ts <command> [options]

読み取り:
  validate                     現行版と履歴の全バージョンを検証する
  show                         表示する

バージョン:
  bump                         現行版の次のバージョンを作る（build は引き継ぐ。closed は落とす）

build:
  build:add --id <id> --name <name> --verify <text> [--verify <text>...] [--uses <id,id>] [--state <state>] [--text <text>]
  build:set --id <id> [--name <name>] [--verify <text>...] [--uses <id,id>] [--state <state>] [--text <text>]
  build:rename --id <id> --to <new-id>
  build:remove --id <id>       参照が1つも無いときだけ削除できる

ticket:
  ticket:add --build <id> --condition <text|null> --title <text> --verify <text> [--build ... --condition ...]*
  ticket:set --id <tkt-0001> [--title <text>] [--verify <text>] [--status <status>]
  ticket:remove --id <tkt-0001>
  ticket:list

verify は「観測できる結果」の列。--verify を繰り返して複数書く（少なくとも1つ必要）。
カンマでは区切らない（条件の文に読点が入りうるため）。
build:set で --verify を渡すと列全体を置き換える。

更新系は指定したフラグだけを変更する（省略したものは現状のまま）。
1つも指定しなければエラーになる。追加だけは既定値を持つ（build は planned から始まる）。
status は宣言値。チケットからは導出されない。
  build の state: ${BUILD_STATES.join(' | ')}
  ticket の status: todo | doing | done（done は自動で archive へ移る）
id は小文字とハイフンで2セグメント以上。先頭は種別。${BUILD_ID_HINT}

共通オプション:
  --type <product|harness>     対象の層（既定: product）
  --version <n>                対象バージョン（既定: 現行版）
  --root <path>                リポジトリのルート（既定: カレント）`;

/** 対象バージョンの Spec を読む。--version 省略時は現行版。 */
async function load(options: Options): Promise<{ version: number; spec: Spec }> {
  const version = options.version ?? (await currentVersion(options.root, options.specType));
  return { version, spec: await readSpec(options.root, options.specType, version) };
}

/**
 * 対象バージョンが現行版ならスナップショットを返す。過去版なら undefined。
 * 過去版への書き込みはチケットと一致しなくてよいので、整合検査を省く。
 */
async function currentSnapshotIfCurrent(
  options: Options,
  version: number,
): Promise<Snapshot | undefined> {
  if (version !== (await currentVersion(options.root, options.specType))) {
    return undefined;
  }
  return loadSnapshot(options.root, options.specType);
}

/**
 * 現行版とチケットを読み、検証してから使う。
 * 現行版を触るコマンドは必ずこれを通す（progress の整合を保つため）。
 */
async function withSnapshot(
  options: Options,
  use: (snapshot: Snapshot) => void,
): Promise<Snapshot> {
  const snapshot = await loadSnapshot(options.root, options.specType);
  throwIfIssues(snapshot);
  use(snapshot);
  return snapshot;
}

/** 現行版かどうか。過去版への書き込みを警告するために使う。 */
async function isCurrent(options: Options, version: number): Promise<boolean> {
  return version === (await currentVersion(options.root, options.specType));
}

function statusLine(build: Build): string {
  const progress =
    build.progress === undefined ? '-' : `${build.progress.done}/${build.progress.total}`;
  return `  ${build.status.state.padEnd(8)} ${progress.padStart(5)}  ${build.id}  ${build.status.text}`;
}

function printSpec(spec: Spec, options: Options, version: number): void {
  const label = `${options.specType}/${formatVersion(version)}`;
  console.log(`${label}  ${spec.name}`);
  console.log(`  goal:    ${spec.goal.length === 0 ? '-' : spec.goal.join(' / ')}`);
  console.log(`  nongoal: ${spec.nongoal.length === 0 ? '-' : spec.nongoal.join(' / ')}`);
  console.log(`  build:   ${spec.build.length} 件`);
  for (const build of spec.build) {
    console.log(statusLine(build));
  }
}

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
 * 過去版は読み込んで形を確かめるだけ。progress はその時点のスナップショットなので、
 * 今のチケットと一致するはずがなく、突き合わせると常に落ちる。
 * 現行版だけ cross-document の検証（progress の突き合わせ、targets の参照解決、
 * working の被覆）を行う。
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
 * 次バージョンを作る。番号は現行+1で、引数では指定しない。
 * build は引き継ぐ。破壊的変更は「一部を変える」ことであって「全部消す」ことではない。
 *
 * closed の build はここで落とす（build リストが縮む唯一の瞬間）。
 * ただし他から参照されているものは残す。参照が切れた状態で履歴に入れたくないため。
 * 自動で触るのは closed だけで、planned / building / working / retiring は残す。
 *
 * progress は引き継がず、新バージョンの数え方で置き直す。progress の算出元は
 * バージョンに属さないチケットなので、引き継ぐと必ずずれる（v001 では正しい値が
 * v002 では嘘になる）。新バージョンの archive はまだ無いので、open だけで数える。
 */
async function runBump(options: Options): Promise<void> {
  const snapshot = await loadSnapshot(options.root, options.specType);
  const version = snapshot.version;
  const next = version + 1;

  const dropped: string[] = [];
  const keptClosed: { id: string; blockers: string[] }[] = [];
  const kept: Build[] = [];
  for (const build of snapshot.spec.build) {
    if (build.status.state !== 'closed') {
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

/** 書き込み前に、対象バージョンが現行かどうかを確認して警告する。 */
async function warnIfHistoric(options: Options, version: number): Promise<void> {
  if (await isCurrent(options, version)) {
    return;
  }
  console.warn(
    `warning: ${options.specType}/${formatVersion(version)} は現行版ではありません。履歴を書き換えます。`,
  );
}

/** 対象の build だけを差し替えた build 配列を返す。見つからなければ null。 */
function withBuild(spec: Spec, id: string, update: (build: Build) => Build): Spec | null {
  if (!spec.build.some((build) => build.id === id)) {
    return null;
  }
  return { ...spec, build: spec.build.map((build) => (build.id === id ? update(build) : build)) };
}

/** 対象の build を取得する。見つからなければエラーで終了する。 */
function findBuild(spec: Spec, id: string): Build {
  const found = spec.build.find((build) => build.id === id);
  if (found === undefined) {
    fail(`build が見つかりません: ${id}`);
  }
  return found;
}

/**
 * 削除の前提条件を検査する。参照が1つでもあれば拒否する。
 * 参照の列挙は store.ts に集約する（spec 内の uses とチケットの targets の両方を見る）。
 */
function assertRemovable(snapshot: Snapshot, build: Build): void {
  const blockers = removalBlockers(snapshot, build.id);
  if (blockers.length === 0) {
    return;
  }
  fail(
    `build を削除できません: ${build.id}\n  次のものが参照しています: ${blockers.join(', ')}\n  先に参照を外すか、その build も削除してください。`,
  );
}

/** 削除した build を除いた Spec を返す。 */
function withoutBuild(spec: Spec, id: string): Spec {
  return { ...spec, build: spec.build.filter((build) => build.id !== id) };
}

async function runBuildAdd(options: Options): Promise<void> {
  const { version, spec } = await load(options);
  await warnIfHistoric(options, version);
  const id = readId(options, 'id', '--id');
  if (spec.build.some((build) => build.id === id)) {
    fail(`build は既に存在します: ${id}`);
  }
  const added: Build = {
    id,
    name: requireValue(options, 'name', '--name'),
    verify: readVerify(options, '--verify'),
    uses: readUses(single(options, 'uses')),
    status: {
      // 新規 build は定義上プランから始まる。更新系の「省略＝変更しない」とは別。
      state: has(options, 'state') ? readState(single(options, 'state')) : 'planned',
      text: requireValue(options, 'text', '--text'),
    },
  };
  const file = await writeSpec(options.root, options.specType, version, {
    ...spec,
    build: [...spec.build, added],
  });
  console.log(`added ${id} -> ${file}`);
}

/**
 * 既存 build を更新する。省略したフラグは変更しない。
 * 更新系で既定値にフォールバックすると、指定し忘れが黙って値を上書きする。
 */
async function runBuildSet(options: Options): Promise<void> {
  const { version, spec } = await load(options);
  const snapshot = await currentSnapshotIfCurrent(options, version);
  const id = readId(options, 'id', '--id');
  const current = findBuild(spec, id);

  const touched =
    has(options, 'name') ||
    has(options, 'verify') ||
    has(options, 'uses') ||
    has(options, 'state') ||
    has(options, 'text');
  if (!touched) {
    fail(
      'build:set には少なくとも1つ変更するフラグが必要です（--name / --verify / --uses / --state / --text）',
    );
  }

  const nextState = has(options, 'state')
    ? readState(single(options, 'state'))
    : current.status.state;
  assertTransition(current.status.state, nextState);

  const updated: Build = {
    ...current,
    name: has(options, 'name') ? requireValue(options, 'name', '--name') : current.name,
    verify: has(options, 'verify') ? readVerify(options, '--verify') : current.verify,
    uses: has(options, 'uses') ? readUses(single(options, 'uses')) : current.uses,
    status: {
      state: nextState,
      text: has(options, 'text') ? requireValue(options, 'text', '--text') : current.status.text,
    },
  };

  const next = withBuild(spec, id, () => updated);
  if (next === null) {
    fail(`build が見つかりません: ${id}`);
  }
  if (snapshot !== undefined) {
    assertCandidateAcceptable(snapshot, next);
  }

  await warnIfHistoric(options, version);
  const file = await writeSpec(options.root, options.specType, version, next);
  console.log(`updated ${id} -> ${file}`);
}

/** id と uses だけを置換した build を返す（rename 用）。 */
function renamedBuild(build: Build, from: string, to: string): Build {
  return {
    id: build.id === from ? to : build.id,
    name: build.name,
    verify: build.verify,
    uses: build.uses.map((used) => (used === from ? to : used)),
    ...(build.progress === undefined ? {} : { progress: build.progress }),
    status: build.status,
  };
}

/** id を変更し、uses とチケットの参照も同時に書き換える。手で置換させないためのコマンド。 */
async function runBuildRename(options: Options): Promise<void> {
  const { version, spec } = await load(options);
  const snapshot = await currentSnapshotIfCurrent(options, version);
  const from = readId(options, 'id', '--id');
  const to = readId(options, 'to', '--to');
  if (from === to) {
    fail(`--id と --to が同じです: ${from}`);
  }
  if (spec.build.some((build) => build.id === to)) {
    fail(`build は既に存在します: ${to}`);
  }
  findBuild(spec, from);

  const renamed: Spec = {
    ...spec,
    build: spec.build.map((build) => renamedBuild(build, from, to)),
  };

  await warnIfHistoric(options, version);

  // チケットの参照も同時に書き換える。片方だけだと参照切れになる。
  // チケットを先に書き、その後 spec を書く（途中で落ちても検証が不整合を検出できる）。
  if (snapshot !== undefined) {
    const tickets = renameBuildInTickets([...snapshot.open, ...snapshot.archived], from, to);
    await persist(snapshot, tickets, renamed);
    console.log(`renamed ${from} -> ${to} -> ${ticketsFile(options.root)}`);
    return;
  }

  const file = await writeSpec(options.root, options.specType, version, renamed);
  console.log(`renamed ${from} -> ${to} -> ${file}`);
}

/**
 * build を削除する。参照が1つでもあれば拒否する。
 * 手で消すためのコマンドで、誤って作った build を更地に戻すためのもの。
 * 「実在した work を終わらせる」は closed であって削除ではない。
 */
async function runBuildRemove(options: Options): Promise<void> {
  const id = readId(options, 'id', '--id');
  const snapshot = await withSnapshot(options, (current) => {
    assertRemovable(current, findBuild(current.spec, id));
  });

  await warnIfHistoric(options, snapshot.version);
  const file = await writeSpec(
    options.root,
    options.specType,
    snapshot.version,
    withoutBuild(snapshot.spec, id),
  );
  console.log(`removed ${id} -> ${file}`);
}

async function runCommand(command: string, options: Options): Promise<void> {
  switch (command) {
    case 'validate':
      return runValidate(options);
    case 'show':
      return runShow(options);
    case 'bump':
      return runBump(options);
    case 'build:add':
      return runBuildAdd(options);
    case 'build:set':
      return runBuildSet(options);
    case 'build:rename':
      return runBuildRename(options);
    case 'build:remove':
      return runBuildRemove(options);
    case 'ticket:add':
      return runTicketAdd(options);
    case 'ticket:set':
      return runTicketSet(options);
    case 'ticket:remove':
      return runTicketRemove(options);
    case 'ticket:list':
      return runTicketList(options);
    default: {
      // 未知のコマンドは使い方を出して異常終了する
      console.log(USAGE);
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined) {
    console.log(USAGE);
    return;
  }
  await runCommand(command, parseOptions(rest));
}

try {
  await main();
} catch (error) {
  // 検証エラーは多行になるのでそのまま見せる
  const detail = error instanceof DocumentError ? error.message : messageOf(error);
  console.error(detail);
  process.exit(1);
}
