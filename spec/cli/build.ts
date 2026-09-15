import {
  assertTransition,
  fail,
  has,
  readBuildStatus,
  readId,
  readUses,
  readVerify,
  requireValue,
  single,
  type Options,
} from './args.ts';
import { writeSpec, type Build, type Spec } from '../lib/spec.ts';
import {
  assertCandidateAcceptable,
  persist,
  removalBlockers,
  renameBuildInTickets,
  type Snapshot,
} from '../lib/store.ts';
import { ticketsFile } from '../lib/ticket.ts';
import {
  currentSnapshotIfCurrent,
  load,
  warnIfHistoric,
  withSnapshot as withValidSnapshot,
} from './shared.ts';

// build のコマンド。build は spec ドキュメントの中身なので、書き込み先は versions 側。

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

/** id と uses を置換し、note を新しい理由で上書きした build を返す（rename 用）。 */
function renamedBuild(build: Build, from: string, to: string, note: string): Build {
  return {
    id: build.id === from ? to : build.id,
    name: build.name,
    verify: build.verify,
    uses: build.uses.map((used) => (used === from ? to : used)),
    ...(build.progress === undefined ? {} : { progress: build.progress }),
    status: build.status,
    note,
  };
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
    // 新規 build は定義上プランから始まる。更新系の「省略＝変更しない」とは別。
    status: has(options, 'status') ? readBuildStatus(single(options, 'status')) : 'planned',
    note: requireValue(options, 'note', '--note'),
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
    has(options, 'status') ||
    has(options, 'note');
  if (!touched) {
    fail(
      'build:set には少なくとも1つ変更するフラグが必要です（--name / --verify / --uses / --status / --note）',
    );
  }

  const nextStatus = has(options, 'status')
    ? readBuildStatus(single(options, 'status'))
    : current.status;
  assertTransition(current.status, nextStatus);

  const updated: Build = {
    ...current,
    name: has(options, 'name') ? requireValue(options, 'name', '--name') : current.name,
    verify: has(options, 'verify') ? readVerify(options, '--verify') : current.verify,
    uses: has(options, 'uses') ? readUses(single(options, 'uses')) : current.uses,
    status: nextStatus,
    // 何を変えるにも理由を要求する。note だけの更新も許す（古い注記を直すため）。
    note: requireValue(options, 'note', '--note'),
  };

  const next = withBuild(spec, id, () => updated);
  if (next === null) {
    fail(`build が見つかりません: ${id}`);
  }
  // チケットが参照している条件を消す変更は、書く前に止める。
  if (snapshot !== undefined) {
    assertCandidateAcceptable(snapshot, next);
  }

  await warnIfHistoric(options, version);
  const file = await writeSpec(options.root, options.specType, version, next);
  console.log(`updated ${id} -> ${file}`);
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

  const note = requireValue(options, 'note', '--note');
  const renamed: Spec = {
    ...spec,
    build: spec.build.map((build) => renamedBuild(build, from, to, note)),
  };

  await warnIfHistoric(options, version);

  // チケットの参照も同時に書き換える。片方だけだと参照切れになる。
  // チケットを先に書き、その後 spec を書く（途中で落ちても検証が不整合を検出できる）。
  if (snapshot !== undefined) {
    const tickets = renameBuildInTickets([...snapshot.open, ...snapshot.archived], from, to);
    await persist(snapshot, tickets, renamed);
    console.log(`renamed ${from} -> ${to} -> ${ticketsFile(options.root, options.specType)}`);
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
  const snapshot = await withValidSnapshot(options, (current) => {
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

export { runBuildAdd, runBuildRemove, runBuildRename, runBuildSet };
