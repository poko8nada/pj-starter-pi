import { DocumentError, formatIssues, type Issue } from './document.ts';
import {
  currentVersion,
  readSpec,
  referencingBuilds,
  type Build,
  type Spec,
  type SpecType,
} from './schema.ts';
import {
  archiveFile,
  emptyTicketFile,
  readTicketFile,
  ticketsFile,
  type Ticket,
} from './ticket.ts';

// 複数ドキュメントをまたぐ読み込みと検証。
// schema.ts / ticket.ts は「1つの文書の形」しか見ないので、文書をまたぐものはここに置く。
//
// 扱うもの:
//   - 現行 spec と tickets の同時読み込み
//   - progress の算出（チケットから）
//   - cross-document 検証（targets の参照解決、status の被覆）

/** 読み込んだ一枚分の状態。 */
export interface Snapshot {
  readonly root: string;
  readonly specType: SpecType;
  readonly version: number;
  readonly spec: Spec;
  /** open なチケット（todo / doing）。 */
  readonly open: readonly Ticket[];
  /** 現行バージョンで done になったチケット。 */
  readonly archived: readonly Ticket[];
}

/** 存在しないファイルは「まだ無い」として扱う（tickets は最初は空）。 */
async function readTicketsOrEmpty(file: string): Promise<readonly Ticket[]> {
  try {
    const parsed = await readTicketFile(file);
    return parsed.ticket;
  } catch (error) {
    if (error instanceof DocumentError && error.message.startsWith('読み込めません')) {
      return emptyTicketFile().ticket;
    }
    throw error;
  }
}

/** 現行 spec と、そのバージョンに関係するチケットを読み込む。 */
export async function loadSnapshot(root: string, specType: SpecType): Promise<Snapshot> {
  const version = await currentVersion(root, specType);
  const spec = await readSpec(root, specType, version);
  // 読むファイルは常に2つ（current と archive/vN）。バージョンが上がっても増えない。
  const open = await readTicketsOrEmpty(ticketsFile(root));
  const archived = await readTicketsOrEmpty(archiveFile(root, version));
  return { root, specType, version, spec, open, archived };
}

// ---- progress の算出 ----

/**
 * その build を指すチケットを集める。
 * open と、現行バージョンで done になったもの（archive）。
 * 過去バージョンで done にしたチケットは含めない（bump で台帳がリセットされる）。
 */
function ticketsFor(snapshot: Snapshot, buildId: string): Ticket[] {
  const isTarget = (ticket: Ticket) => ticket.targets.some((target) => target.build === buildId);
  return [...snapshot.open, ...snapshot.archived].filter(isTarget);
}

/**
 * build ごとの progress を算出する。
 * チケットが0件の build はエントリ自体を作らない（0/0 とは書かない）。
 */
export function computeProgress(snapshot: Snapshot): Map<string, { done: number; total: number }> {
  const result = new Map<string, { done: number; total: number }>();
  for (const build of snapshot.spec.build) {
    const tickets = ticketsFor(snapshot, build.id);
    if (tickets.length === 0) {
      continue;
    }
    const done = tickets.filter((ticket) => ticket.status === 'done').length;
    result.set(build.id, { done, total: tickets.length });
  }
  return result;
}

/** progress を反映した build を返す。UI 表示用で、ファイルには書かない。 */
export function buildWithProgress(
  snapshot: Snapshot,
): (Build & { progress?: { done: number; total: number } })[] {
  const progress = computeProgress(snapshot);
  return snapshot.spec.build.map((build) => {
    const value = progress.get(build.id);
    return value === undefined ? { ...build } : { ...build, progress: value };
  });
}

// ---- cross-document 検証 ----

/**
 * チケットの targets が実在の build と条件を指しているかを検証する。
 * 参照切れは常に異常。build:rename / build:remove が取りこぼしたらここで止まる。
 */
function validateTargets(snapshot: Snapshot, issues: Issue[]): void {
  const byId = new Map(snapshot.spec.build.map((build) => [build.id, build]));
  const all = [...snapshot.open, ...snapshot.archived];
  for (const ticket of all) {
    for (const target of ticket.targets) {
      const label = `tickets.${ticket.id}.targets`;
      const build = byId.get(target.build);
      if (build === undefined) {
        issues.push({ path: label, message: `存在しない build を参照しています: ${target.build}` });
        continue;
      }
      if (target.condition !== null && !build.verify.includes(target.condition)) {
        issues.push({
          path: label,
          message: `build ${build.id} に存在しない条件を参照しています: ${target.condition}`,
        });
      }
    }
  }
}

/**
 * status の被覆検査。
 * working を宣言した build は、すべての条件が done のチケットから参照されている必要がある。
 * status は宣言値のままなので、根拠を要求するのはここだけ。
 *
 * 適用範囲は「チケットが1件以上ある build」に限る。
 * スターターの harness は ticket 無しで working なので、これを課すと壊れる。
 * retiring / closed は対象外（条件を満たす前に畳むのは正当）。
 */
function validateWorkingCoverage(snapshot: Snapshot, issues: Issue[]): void {
  for (const build of snapshot.spec.build) {
    if (build.status.state !== 'working') {
      continue;
    }
    const tickets = ticketsFor(snapshot, build.id);
    if (tickets.length === 0) {
      continue;
    }
    const doneConditions = new Set(
      tickets
        .filter((ticket) => ticket.status === 'done')
        .flatMap((ticket) =>
          ticket.targets
            .filter((target) => target.build === build.id && target.condition !== null)
            .map((target) => target.condition),
        ),
    );
    for (const condition of build.verify) {
      if (!doneConditions.has(condition)) {
        issues.push({
          path: `spec.${build.id}`,
          message: `status が working ですが、条件が done になっていません: ${condition}`,
        });
      }
    }
  }
}

/**
 * progress の突き合わせ検査。
 * spec 側に書かれた progress がチケットの集計と一致するかを確かめる。
 * 現行版にだけ適用する（過去版の progress はその時点のスナップショットなので一致しない）。
 */
function validateProgress(snapshot: Snapshot, issues: Issue[]): void {
  const expected = computeProgress(snapshot);
  for (const build of snapshot.spec.build) {
    const actual = build.progress;
    const want = expected.get(build.id);
    const label = `spec.${build.id}.progress`;
    if (want === undefined && actual === undefined) {
      continue;
    }
    if (want === undefined) {
      issues.push({ path: label, message: 'チケットが0件なので progress を持てません' });
      continue;
    }
    if (actual === undefined) {
      issues.push({
        path: label,
        message: `チケットが${want.total}件あるので progress が必要です（${want.done}/${want.total}）`,
      });
      continue;
    }
    if (actual.done !== want.done || actual.total !== want.total) {
      issues.push({
        path: label,
        message: `チケットの集計と一致しません。期待: ${want.done}/${want.total}、実際: ${actual.done}/${actual.total}`,
      });
    }
  }
}

/**
 * 文書をまたぐ検証をまとめて行う。
 * 現行版にだけ適用する。過去版は凍結されたスナップショットなので、チケットと一致しなくてよい。
 */
export function validateSnapshot(snapshot: Snapshot): readonly Issue[] {
  const issues: Issue[] = [];
  validateTargets(snapshot, issues);
  validateProgress(snapshot, issues);
  validateWorkingCoverage(snapshot, issues);
  return issues;
}

/** 検証して、問題があれば投げる。書き込み前に必ず呼ぶ。 */
export async function assertValidSnapshot(root: string, specType: SpecType): Promise<Snapshot> {
  const snapshot = await loadSnapshot(root, specType);
  const issues = validateSnapshot(snapshot);
  if (issues.length > 0) {
    throw new DocumentError(formatIssues(`spec/${specType}`, issues));
  }
  return snapshot;
}

/**
 * build を削除してよいかを判定する。参照を1箇所で見るための入口。
 * spec 内の uses と、チケットの targets の両方を見る。
 */
export function removalBlockers(snapshot: Snapshot, buildId: string): string[] {
  const fromBuilds = referencingBuilds(snapshot.spec, buildId).map((id) => `build ${id}`);
  const fromTickets = [...snapshot.open, ...snapshot.archived]
    .filter((ticket) => ticket.targets.some((target) => target.build === buildId))
    .map((ticket) => `ticket ${ticket.id}`);
  return [...fromBuilds, ...fromTickets];
}
