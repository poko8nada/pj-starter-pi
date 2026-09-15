import {
  BUILD_ID_HINT,
  BUILD_STATES,
  currentVersion,
  formatVersion,
  readSpec,
  type Build,
  type Spec,
} from '../lib/spec.ts';
import { loadSnapshot, throwIfIssues, type Snapshot } from '../lib/store.ts';
import type { Options } from './args.ts';

// コマンド実装の共通部分。読み込み、検証、表示。
// 「どのコマンドからも使うが、コマンド固有ではないもの」をここに置く。

export const USAGE = `spec - spec/ の JSON を検証・更新する

使い方:
  node spec/cli.ts <command> [options]

読み取り:
  validate                     現行版と履歴の全バージョンを検証する
  show                         表示する

バージョン:
  bump                         現行版の次のバージョンを作る（build は引き継ぐ。closed は落とす）

build:
  build:add --id <id> --name <name> --verify <text> [--verify <text>...] [--uses <id,id>] [--status <status>] --note <text>
  build:set --id <id> [--name <name>] [--verify <text>...] [--uses <id,id>] [--status <status>] --note <text>
  build:rename --id <id> --to <new-id> --note <text>
  build:remove --id <id>       参照が1つも無いときだけ削除できる

ticket:
  ticket:add --build <id> --condition <text|null> --title <text> --verify <text> --note <text> [--build ... --condition ...]*
  ticket:set --id <tkt-0001> [--title <text>] [--verify <text>] [--status <status>] --note <text>
  ticket:remove --id <tkt-0001>
  ticket:list

verify は「観測できる結果」の列。--verify を繰り返して複数書く（少なくとも1つ必要）。
カンマでは区切らない（条件の文に読点が入りうるため）。
build:set で --verify を渡すと列全体を置き換える。

--note は変更の理由。何かを変えるなら必ず要る（--note だけの更新も許す）。
消える操作（remove）と機械的な操作（bump）には要らない。
更新系は指定したフラグだけを変更する（省略したものは現状のまま）。
1つも指定しなければエラーになる。追加だけは既定値を持つ（build は planned から始まる）。
status は宣言値。チケットからは導出されない。
  build の status: ${BUILD_STATES.join(' | ')}
  ticket の status: todo | doing | done（done は自動で archive へ移る）
id は小文字とハイフンで2セグメント以上。先頭は種別。${BUILD_ID_HINT}

共通オプション:
  --type <product|harness>     対象の層（既定: product）
  --version <n>                対象バージョン（既定: 現行版）
  --root <path>                リポジトリのルート（既定: カレント）`;

/** 対象バージョンの Spec を読む。--version 省略時は現行版。 */
export async function load(options: Options): Promise<{ version: number; spec: Spec }> {
  const version = options.version ?? (await currentVersion(options.root, options.specType));
  return { version, spec: await readSpec(options.root, options.specType, version) };
}

/**
 * 対象バージョンが現行版ならスナップショットを返す。過去版なら undefined。
 * 過去版への書き込みはチケットと一致しなくてよいので、整合検査を省く。
 */
export async function currentSnapshotIfCurrent(
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
export async function withSnapshot(
  options: Options,
  use: (snapshot: Snapshot) => void,
): Promise<Snapshot> {
  const snapshot = await loadSnapshot(options.root, options.specType);
  throwIfIssues(snapshot);
  use(snapshot);
  return snapshot;
}

/** 現行版かどうか。過去版への書き込みを警告するために使う。 */
export async function isCurrent(options: Options, version: number): Promise<boolean> {
  return version === (await currentVersion(options.root, options.specType));
}

/** 書き込み前に、対象バージョンが現行かどうかを確認して警告する。 */
export async function warnIfHistoric(options: Options, version: number): Promise<void> {
  if (await isCurrent(options, version)) {
    return;
  }
  console.warn(
    `warning: ${options.specType}/${formatVersion(version)} は現行版ではありません。履歴を書き換えます。`,
  );
}

function statusLine(build: Build): string {
  const progress =
    build.progress === undefined ? '-' : `${build.progress.done}/${build.progress.total}`;
  return `  ${build.status.padEnd(8)} ${progress.padStart(5)}  ${build.id}  ${build.note}`;
}

export function printSpec(spec: Spec, options: Options, version: number): void {
  const label = `${options.specType}/${formatVersion(version)}`;
  console.log(`${label}  ${spec.name}`);
  console.log(`  goal:    ${spec.goal.length === 0 ? '-' : spec.goal.join(' / ')}`);
  console.log(`  nongoal: ${spec.nongoal.length === 0 ? '-' : spec.nongoal.join(' / ')}`);
  console.log(`  build:   ${spec.build.length} 件`);
  for (const build of spec.build) {
    console.log(statusLine(build));
  }
}
