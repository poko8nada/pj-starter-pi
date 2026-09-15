import { parseArgs } from 'node:util';
import {
  BUILD_ID_HINT,
  BUILD_STATES,
  canTransition,
  currentVersion,
  formatVersion,
  isSpecType,
  isValidBuildId,
  listVersions,
  messageOf,
  readSpec,
  referencingBuilds,
  SpecError,
  specTypeDir,
  TRANSITION_RULE,
  writeSpec,
  type Build,
  type BuildState,
  type Spec,
  type SpecType,
} from './schema.ts';

// spec/ の CLI。JSON の読み書きは schema.ts の関数だけを通す。
// ここには「引数の解釈」「遷移の制約」「表示」以外を書かない。
//
// 遷移の制約を schema.ts ではなくここに置く理由:
// parseSpec は「前の状態」を知らないので、単体では判定できない。

const USAGE = `spec - spec/ の JSON を検証・更新する

使い方:
  node spec/cli.ts <command> [options]

読み取り:
  validate                     現行版と履歴の全バージョンを検証する
  show                         表示する

バージョン:
  bump                         現行版の次のバージョンを作る（build は引き継ぐ。closed は落とす）

build の更新:
  build:add --id <id> --name <name> --verify <text> [--uses <id,id>] [--state <state>] [--text <text>]
  build:set --id <id> [--name <name>] [--verify <text>] [--uses <id,id>] [--state <state>] [--text <text>]
  build:rename --id <id> --to <new-id>
  build:remove --id <id>       参照が1つも無いときだけ削除できる

build:set は指定したフラグだけを変更する（省略したものは現状のまま）。
1つも指定しなければエラーになる。
status は宣言値。チケットからは導出されない。state は ${BUILD_STATES.join(' | ')} のいずれか。
id は小文字とハイフンで2セグメント以上。先頭は種別。${BUILD_ID_HINT}

共通オプション:
  --type <product|harness>     対象の層（既定: product）
  --version <n>                対象バージョン（既定: 現行版）
  --root <path>                リポジトリのルート（既定: カレント）`;

interface Options {
  readonly root: string;
  readonly specType: SpecType;
  readonly version: number | undefined;
  readonly values: Record<string, string | undefined>;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** --type の値を語彙に突き合わせる。語彙外は即エラー。 */
function readSpecType(raw: string | undefined): SpecType {
  const value = raw ?? 'product';
  if (!isSpecType(value)) {
    fail(`--type は次のいずれかです: product, harness（受け取った値: ${value}）`);
  }
  return value;
}

function readVersion(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    fail(`--version は正の整数です（受け取った値: ${raw}）`);
  }
  return Number(raw);
}

function parseOptions(args: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...args],
    options: {
      type: { type: 'string' },
      version: { type: 'string' },
      root: { type: 'string' },
      to: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      verify: { type: 'string' },
      uses: { type: 'string' },
      state: { type: 'string' },
      text: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    root: values.root ?? process.cwd(),
    specType: readSpecType(values.type),
    version: readVersion(values.version),
    values,
  };
}

/** フラグが指定されたか。更新系で「省略＝変更しない」を判定するために使う。 */
function has(options: Options, key: string): boolean {
  return options.values[key] !== undefined;
}

function requireValue(options: Options, key: string, flag: string): string {
  const value = options.values[key];
  if (value === undefined || value === '') {
    fail(`${flag} は必須です`);
  }
  return value;
}

/** --state の値を語彙に突き合わせる。 */
function readState(raw: string | undefined): BuildState {
  const matched = BUILD_STATES.find((state) => state === raw);
  if (matched === undefined) {
    fail(`--state は次のいずれかです: ${BUILD_STATES.join(', ')}（受け取った値: ${raw}）`);
  }
  return matched;
}

/** --id の形を検証する。schema と同じ基準を入口でも適用して早く失敗させる。 */
function readId(options: Options, key: string, flag: string): string {
  const value = requireValue(options, key, flag);
  if (!isValidBuildId(value)) {
    fail(
      `${flag} の形式が不正です: ${value}\n  小文字とハイフンで2セグメント以上（先頭は種別）。${BUILD_ID_HINT}`,
    );
  }
  return value;
}

function readUses(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

/**
 * status の遷移制約。単体では判定できないので CLI 層に置く。
 * 規則は schema.ts の canTransition が持つ（型と語彙と同じ場所に集約する）。
 */
function assertTransition(from: BuildState, to: BuildState): void {
  if (canTransition(from, to)) {
    return;
  }
  fail(`state を ${from} から planned には戻せません（${from} -> ${to}）\n  ${TRANSITION_RULE}`);
}

/** 対象バージョンの Spec を読む。--version 省略時は現行版。 */
async function load(options: Options): Promise<{ version: number; spec: Spec }> {
  const version = options.version ?? (await currentVersion(options.root, options.specType));
  return { version, spec: await readSpec(options.root, options.specType, version) };
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
  // 現行版だけでなく履歴も検証する。過去版は凍結されるが、壊れたまま残したくない。
  // 同時実行はしない。1件目で落ちたときに残りを無駄に読まないため順序を保つ。
  const results: string[] = [];
  for (const version of versions) {
    // oxlint-disable-next-line no-await-in-loop -- 検証は順序よく、失敗は即中断する
    await readSpec(options.root, options.specType, version);
    results.push(`ok  ${options.specType}/${formatVersion(version)}`);
  }
  for (const line of results) {
    console.log(line);
  }
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
 */
async function runBump(options: Options): Promise<void> {
  const { version, spec } = await load(options);
  const next = version + 1;

  const dropped: string[] = [];
  const keptClosed: { id: string; blockers: string[] }[] = [];
  const kept: Build[] = [];
  for (const build of spec.build) {
    if (build.status.state !== 'closed') {
      kept.push(build);
      continue;
    }
    const blockers = referencingBuilds(spec, build.id);
    if (blockers.length > 0) {
      keptClosed.push({ id: build.id, blockers });
      kept.push(build);
      continue;
    }
    dropped.push(build.id);
  }

  const file = await writeSpec(options.root, options.specType, next, { ...spec, build: kept });
  console.log(
    `created ${file} (from ${formatVersion(version)}, ${kept.length} builds carried over)`,
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
 *
 * チケットが入ったら、open なチケットの targets もここで見る。
 * 参照を切る場所を1箇所に集約しておくことで、追加時に漏れないようにする。
 */
function assertRemovable(spec: Spec, build: Build): void {
  const blockers = referencingBuilds(spec, build.id);
  if (blockers.length === 0) {
    return;
  }
  fail(
    `build を削除できません: ${build.id}\n  次の build が uses で参照しています: ${blockers.join(', ')}\n  先に参照を外すか、その build も削除してください。`,
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
    verify: requireValue(options, 'verify', '--verify'),
    uses: readUses(options.values.uses),
    status: {
      // 新規 build は定義上プランから始まる。更新系の「省略＝変更しない」とは別。
      state: has(options, 'state') ? readState(options.values.state) : 'planned',
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

  const nextState = has(options, 'state') ? readState(options.values.state) : current.status.state;
  assertTransition(current.status.state, nextState);

  const updated: Build = {
    ...current,
    name: has(options, 'name') ? requireValue(options, 'name', '--name') : current.name,
    verify: has(options, 'verify') ? requireValue(options, 'verify', '--verify') : current.verify,
    uses: has(options, 'uses') ? readUses(options.values.uses) : current.uses,
    status: {
      state: nextState,
      text: has(options, 'text') ? requireValue(options, 'text', '--text') : current.status.text,
    },
  };

  await warnIfHistoric(options, version);
  const file = await writeSpec(
    options.root,
    options.specType,
    version,
    withBuild(spec, id, () => updated),
  );
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

/** id を変更し、uses の参照も同時に書き換える。手で置換させないためのコマンド。 */
async function runBuildRename(options: Options): Promise<void> {
  const { version, spec } = await load(options);
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
  const file = await writeSpec(options.root, options.specType, version, renamed);
  console.log(`renamed ${from} -> ${to} -> ${file}`);
}

/**
 * build を削除する。参照が1つでもあれば拒否する。
 * 手で消すためのコマンドで、誤って作った build を更地に戻すためのもの。
 * 「実在した work を終わらせる」は closed であって削除ではない。
 */
async function runBuildRemove(options: Options): Promise<void> {
  const { version, spec } = await load(options);
  const id = readId(options, 'id', '--id');
  const build = findBuild(spec, id);
  assertRemovable(spec, build);

  await warnIfHistoric(options, version);
  const file = await writeSpec(options.root, options.specType, version, withoutBuild(spec, id));
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
  // 検証エラーは多行になるため、そのまま見せる
  const detail = error instanceof SpecError ? error.message : messageOf(error);
  console.error(detail);
  process.exit(1);
}
