import { parseArgs } from 'node:util';
import {
  BUILD_STATES,
  currentVersion,
  formatVersion,
  isSpecType,
  listVersions,
  messageOf,
  readSpec,
  SpecError,
  specTypeDir,
  writeSpec,
  type Build,
  type BuildState,
  type Spec,
  type SpecType,
} from './schema.ts';

// spec/ の CLI。JSON の読み書きは schema.ts の関数だけを通す。
// ここには「引数の解釈」と「表示」以外を書かない。

const USAGE = `spec - spec/ の JSON を検証・更新する

使い方:
  node spec/cli.ts <command> [options]

読み取り:
  validate                     現行版を検証する
  show                         現行版を表示する

バージョン:
  bump --to <n>                現行版を雛形に次版 <n> を作る

build の更新:
  build:add --id <id> --name <name> --verify <text> [--uses <id,id>] [--state <state>] [--text <text>]
  build:state --id <id> --state <state> --text <text>

status は宣言値。チケットからは導出されない。state は ${BUILD_STATES.join(' | ')} のいずれか。

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

function requireValue(options: Options, key: string, flag: string): string {
  const value = options.values[key];
  if (value === undefined || value === '') {
    fail(`${flag} は必須です`);
  }
  return value;
}

/** --state の値を語彙に突き合わせる。 */
function readState(raw: string | undefined, fallback: BuildState): BuildState {
  const value = raw ?? fallback;
  const matched = BUILD_STATES.find((state) => state === value);
  if (matched === undefined) {
    fail(`--state は次のいずれかです: ${BUILD_STATES.join(', ')}（受け取った値: ${value}）`);
  }
  return matched;
}

/** 対象バージョンの Spec を読む。--version 省略時は現行版。 */
async function load(options: Options): Promise<{ version: number; spec: Spec }> {
  const version = options.version ?? (await currentVersion(options.root, options.specType));
  return { version, spec: await readSpec(options.root, options.specType, version) };
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

/** 現行版を雛形に、指定バージョンのファイルを作る（build は引き継がない）。 */
async function runBump(options: Options): Promise<void> {
  const to = readVersion(options.values.to);
  if (to === undefined) {
    fail('bump には --to <n> が必要です');
  }
  const { version, spec } = await load(options);
  if (to <= version) {
    fail(`--to は現行版より大きい必要があります（現行: ${formatVersion(version)}）`);
  }
  const next: Spec = { ...spec, build: [] };
  const file = await writeSpec(options.root, options.specType, to, next);
  console.log(`created ${file}`);
}

async function runBuildAdd(options: Options): Promise<void> {
  const { version, spec } = await load(options);
  const id = requireValue(options, 'id', '--id');
  if (spec.build.some((build) => build.id === id)) {
    fail(`build は既に存在します: ${id}`);
  }
  const uses = (options.values.uses ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const added: Build = {
    id,
    name: requireValue(options, 'name', '--name'),
    verify: requireValue(options, 'verify', '--verify'),
    uses,
    status: {
      state: readState(options.values.state, 'planned'),
      text: requireValue(options, 'text', '--text'),
    },
  };
  const file = await writeSpec(options.root, options.specType, version, {
    ...spec,
    build: [...spec.build, added],
  });
  console.log(`added ${id} -> ${file}`);
}

/** 対象の build だけを差し替えた build 配列を返す。見つからなければ null（呼び出し側でエラーにする）。 */
function withBuild(spec: Spec, id: string, update: (build: Build) => Build): Spec | null {
  if (!spec.build.some((build) => build.id === id)) {
    return null;
  }
  return { ...spec, build: spec.build.map((build) => (build.id === id ? update(build) : build)) };
}

async function runBuildState(options: Options): Promise<void> {
  const { version, spec } = await load(options);
  const id = requireValue(options, 'id', '--id');
  const state = readState(options.values.state, 'planned');
  const text = requireValue(options, 'text', '--text');
  const next = withBuild(spec, id, (build) => ({ ...build, status: { state, text } }));
  if (next === null) {
    fail(`build が見つかりません: ${id}`);
  }
  const file = await writeSpec(options.root, options.specType, version, next);
  console.log(`${id} -> ${state} -> ${file}`);
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
    case 'build:state':
      return runBuildState(options);
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
