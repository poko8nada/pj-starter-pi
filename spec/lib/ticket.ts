import {
  DocumentError,
  formatIssues,
  isMemberOf,
  isRecord,
  readCount,
  readJson,
  readString,
  rejectUnknownKeys,
  writeJson,
  type Issue,
} from './document.ts';
import { isValidBuildId, type SpecType } from './spec.ts';

// チケット（作業）の語彙・型・検証・読み書き。
// build（作るもの）とは別の文書なので、spec.ts とは分ける。
// 両方をまたぐ検証（progress の突き合わせ、targets の参照解決）は store.ts が行う。
//
// 層（product / harness）は**ディレクトリで表す**。フィールドでは持たない。
// product と harness は独立にバージョンが進むので、1箇所に混ぜると
// 「v002 はどちらの v002 か」「この build はどちらの層か」が決まらなくなる。

/**
 * 作業の状態。build の state とは別物で、こちらは作業そのものの進み具合。
 * - todo:  まだ手を付けていない
 * - doing: 作業中
 * - done:  完了
 */
export const TICKET_STATUSES = ['todo', 'doing', 'done'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * どの build の、どの条件を進めるか。
 * condition は build の verify の要素を指す。
 * null は「その build に手を入れるが、条件は進めない」（リファクタ・雑務）。
 */
export interface TicketTarget {
  readonly build: string;
  readonly condition: string | null;
}

export interface Ticket {
  readonly id: string;
  readonly targets: readonly TicketTarget[];
  readonly title: string;
  readonly verify: string;
  readonly status: TicketStatus;
  /**
   * 直近の変更の理由。title / verify / status / targets のどれを変えるときも必要。
   * build の note と同じ意味で、build と ticket を同じ形に揃える。
   */
  readonly note: string;
  /**
   * 機械が書く。done になったときの現行バージョン番号。reopen で消える。
   * アーカイブの発見に使う索引でもある（どの archive から取り出すかが一意に決まる）。
   */
  readonly resolvedIn?: number;
}

/** current.json の中身。open なチケットだけを持つ。層はディレクトリが表す。 */
export interface TicketFile {
  readonly ticket: readonly Ticket[];
}

export function isTicketStatus(value: unknown): value is TicketStatus {
  return isMemberOf(TICKET_STATUSES, value);
}

/** 採番の元にする id の形。build と同じ基準（小文字・ハイフン・2セグメント以上）。 */
const TICKET_ID_HINT = '例: tkt-0001, tkt-0042';

export function isValidTicketId(value: string): boolean {
  return isValidBuildId(value);
}

export function formatTicketId(n: number): string {
  return `tkt-${String(n).padStart(4, '0')}`;
}

/**
 * 次に使う番号を決める。既存の最大 + 1 で、番号は再利用しない。
 * アーカイブ済みも数えるので、終わったチケットの番号が再び使われることはない（履歴が重ならない）。
 */
export function nextTicketNumber(tickets: readonly Ticket[]): number {
  let max = 0;
  for (const ticket of tickets) {
    const matched = /^tkt-(\d+)$/.exec(ticket.id);
    if (matched !== null) {
      max = Math.max(max, Number(matched[1]));
    }
  }
  const next = max + 1;
  return next;
}

// ---- フィールド単位の読み取り ----

function readTicketId(input: unknown, label: string, issues: Issue[]): string | undefined {
  const value = readString(input, label, issues);
  if (value === undefined) {
    return undefined;
  }
  if (!isValidTicketId(value)) {
    issues.push({
      path: label,
      message: `id の形式が不正です: ${value}。小文字とハイフンで2セグメント以上。${TICKET_ID_HINT}`,
    });
    return undefined;
  }
  return value;
}

function readTarget(input: unknown, label: string, issues: Issue[]): TicketTarget | undefined {
  if (!isRecord(input)) {
    issues.push({ path: label, message: 'オブジェクトである必要があります' });
    return undefined;
  }
  rejectUnknownKeys(input, ['build', 'condition'], label, issues);

  const build = readString(input.build, `${label}.build`, issues);
  if (build !== undefined && !isValidBuildId(build)) {
    issues.push({ path: `${label}.build`, message: `build の id の形式が不正です: ${build}` });
    return undefined;
  }

  // null は「触るが条件は進めない」。省略は書き忘れと区別できないので弾く。
  let condition: string | null;
  if (input.condition === null) {
    condition = null;
  } else {
    const read = readString(input.condition, `${label}.condition`, issues);
    if (read === undefined) {
      return undefined;
    }
    condition = read;
  }

  return build === undefined ? undefined : { build, condition };
}

function readTargets(input: unknown, label: string, issues: Issue[]): TicketTarget[] | undefined {
  if (!Array.isArray(input)) {
    issues.push({ path: label, message: '配列である必要があります' });
    return undefined;
  }
  const targets: TicketTarget[] = [];
  for (const [index, item] of input.entries()) {
    const target = readTarget(item, `${label}[${index}]`, issues);
    if (target !== undefined) {
      targets.push(target);
    }
  }
  return targets;
}

/**
 * targets は1件以上必要で、同じ build を2回書けない。
 * この上限が分割の矯正になっている: 1つの ticket は build につき条件1つまで。
 * 2条件を同時に片付けたければ、ticket を2枚に割るか、build を2つに割るかになる。
 */
function validateTargets(targets: readonly TicketTarget[], label: string, issues: Issue[]): void {
  if (targets.length === 0) {
    issues.push({ path: label, message: 'targets には最低1つの build が必要です' });
    return;
  }
  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    if (seen.has(target.build)) {
      issues.push({
        path: `${label}[${index}].build`,
        message: `同じ build を2回指定できません: ${target.build}。条件ごとに ticket を分けてください`,
      });
      continue;
    }
    seen.add(target.build);
  }
}

/** resolvedIn は機械が書く値。省略は「まだ終わっていない」を意味する。 */
function readResolvedIn(input: unknown, label: string, issues: Issue[]): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  return readCount(input, label, issues);
}

// ---- ticket の検証 ----

const TICKET_KEYS = ['id', 'targets', 'title', 'verify', 'status', 'note', 'resolvedIn'] as const;

function readTicket(input: unknown, label: string, issues: Issue[]): Ticket | undefined {
  if (!isRecord(input)) {
    issues.push({ path: label, message: 'オブジェクトである必要があります' });
    return undefined;
  }
  rejectUnknownKeys(input, TICKET_KEYS, label, issues);

  const id = readTicketId(input.id, `${label}.id`, issues);
  const targets = readTargets(input.targets, `${label}.targets`, issues);
  const title = readString(input.title, `${label}.title`, issues);
  const verify = readString(input.verify, `${label}.verify`, issues);
  const note = readString(input.note, `${label}.note`, issues);
  const status = input.status;
  if (!isTicketStatus(status)) {
    issues.push({
      path: `${label}.status`,
      message: `次のいずれかである必要があります: ${TICKET_STATUSES.join(', ')}`,
    });
  }
  const resolvedIn = readResolvedIn(input.resolvedIn, `${label}.resolvedIn`, issues);

  if (id === undefined || targets === undefined || title === undefined || verify === undefined) {
    return undefined;
  }
  if (note === undefined) {
    return undefined;
  }
  if (!isTicketStatus(status)) {
    return undefined;
  }
  validateTargets(targets, `${label}.targets`, issues);

  // done のときだけ resolvedIn を持てる。todo / doing に残っているのは、戻し忘れか不正。
  if (status !== 'done' && resolvedIn !== undefined) {
    issues.push({
      path: `${label}.resolvedIn`,
      message: 'status が done のときだけ持ちます（機械が書く値です）',
    });
    return undefined;
  }
  if (status === 'done' && resolvedIn === undefined) {
    issues.push({
      path: `${label}.resolvedIn`,
      message: 'done の ticket は resolvedIn を持ちます（どのバージョンで終えたか）',
    });
    return undefined;
  }

  return {
    id,
    targets,
    title,
    verify,
    status,
    note,
    ...(resolvedIn === undefined ? {} : { resolvedIn }),
  };
}

/** 任意の入力を検証して TicketFile にする。問題は全件集めて返す。 */
export function parseTicketFile(
  input: unknown,
  label: string,
): { file: TicketFile | undefined; issues: readonly Issue[] } {
  if (!isRecord(input)) {
    return {
      file: undefined,
      issues: [{ path: label, message: 'オブジェクトである必要があります' }],
    };
  }
  const issues: Issue[] = [];
  rejectUnknownKeys(input, ['ticket'], label, issues);

  const raw = input.ticket;
  const tickets: Ticket[] = [];
  if (raw === undefined) {
    issues.push({ path: `${label}.ticket`, message: '必須です（空なら [] を書いてください）' });
  } else if (!Array.isArray(raw)) {
    issues.push({ path: `${label}.ticket`, message: '配列である必要があります' });
  } else {
    const seen = new Set<string>();
    for (const [index, item] of raw.entries()) {
      const itemLabel = `${label}.ticket[${index}]`;
      const ticket = readTicket(item, itemLabel, issues);
      if (ticket === undefined) {
        continue;
      }
      if (seen.has(ticket.id)) {
        issues.push({ path: `${itemLabel}.id`, message: `id が重複しています: ${ticket.id}` });
        continue;
      }
      seen.add(ticket.id);
      tickets.push(ticket);
    }
  }

  if (issues.length > 0) {
    return { file: undefined, issues };
  }
  return { file: { ticket: tickets }, issues };
}

// ---- パスと読み書き ----

export function ticketsFile(root: string, specType: SpecType): string {
  return `${root}/spec/tickets/${specType}/current.json`;
}

/** その層の、そのバージョンで done になったチケット。 */
export function archiveFile(root: string, specType: SpecType, version: number): string {
  const padded = `v${String(version).padStart(3, '0')}`;
  return `${root}/spec/tickets/${specType}/archive/${padded}.json`;
}

/** その層のチケットディレクトリ。全消去など、丸ごと扱うときに使う。 */
export function ticketsDir(root: string, specType: SpecType): string {
  return `${root}/spec/tickets/${specType}`;
}

/** 空の TicketFile を読み書きせずに作る。 */
export function emptyTicketFile(): TicketFile {
  return { ticket: [] };
}

export async function readTicketFile(file: string): Promise<TicketFile> {
  const { file: parsed, issues } = parseTicketFile(await readJson(file), file);
  if (parsed === undefined) {
    throw new DocumentError(formatIssues(file, issues));
  }
  return parsed;
}

/**
 * 検証してから書き込む。検証を通らない入力はファイルに到達しない。
 * ticket は配列の順序を保つ（追記が末尾に来るので git の diff が読みやすい）。
 */
export async function writeTicketFile(file: string, value: unknown): Promise<string> {
  const { file: validated, issues } = parseTicketFile(value, file);
  if (validated === undefined) {
    throw new DocumentError(formatIssues(file, issues));
  }
  return writeJson(file, validated);
}
