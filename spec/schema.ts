import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DocumentError,
  formatIssues,
  isMemberOf,
  isRecord,
  messageOf,
  readCount,
  readJson,
  readString,
  readStringArray,
  rejectUnknownKeys,
  writeJson,
  type Issue,
} from './document.ts';

// spec（product / harness）の語彙・型・検証・読み書き。
// 書き込み経路をこのファイルの関数だけに絞ることで、検証を通らない JSON が spec/ に生まれる余地をなくす。
// 共通のガードと I/O は document.ts にある。

/** spec の2層。product は提供物、harness はそれを運用するメタ層。 */
export const SPEC_TYPES = ['product', 'harness'] as const;
export type SpecType = (typeof SPEC_TYPES)[number];

/**
 * build のライフサイクル。**手で宣言する**。progress からは導出しない。
 * progress（チケットの消化状況）と status（判断）は別の軸として共存する。
 *
 *   planned --> building --> working --> retiring --> closed
 *     始点                                            終点
 *
 * 始点と終点は「無い」、間の3つは「ある」。
 * retiring は「まだあるが、消す作業中」。深く統合されたものの削除は1ステップではないので、
 * その作業に居場所を与えるために要る。
 */
export const BUILD_STATES = ['planned', 'building', 'working', 'retiring', 'closed'] as const;
export type BuildState = (typeof BUILD_STATES)[number];

export const BUILD_STATE_MEANING: Record<BuildState, string> = {
  planned: 'プランだけ',
  building: '作っている最中',
  working: '完成して動いている',
  retiring: 'まだあるが、消す作業中',
  closed: '無くなった',
};

/**
 * 起きたことを消す移動を禁止する。
 * 「一度作って動いたものが、計画だけだったことになる」のは記録の否定になる。
 * 前進（飛ばすのも可）と巻き戻し（building に戻す、retiring をやめる）は許す。
 */
export function canTransition(from: BuildState, to: BuildState): boolean {
  return !(to === 'planned' && from !== 'planned' && from !== 'building');
}

/** 禁止される移動の説明。CLI のエラー文に使う。 */
export const TRANSITION_RULE =
  'planned に戻せるのは planned と building だけです。作って動いたものをプランには戻せません。';

/**
 * id の形。小文字とハイフンのみで、2セグメント以上。
 * 先頭セグメントは「何として外から見えるか」の種別（page, api, cli, gate など）。
 * 種別の語彙はここでは縛らない。まず形だけを矯正し、意味は README の例で導く。
 */
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MIN_ID_SEGMENTS = 2;

/** id の書き方の例。検証違反のメッセージにそのまま差し込む。 */
export const BUILD_ID_HINT =
  '例: page-home, auth-login, api-user-create, cli-spec, gate-quality, hook-lefthook';

/** 形（小文字・ハイフン区切り・2セグメント以上）だけを見る。種別の意味は検証しない。 */
export function isValidBuildId(value: string): boolean {
  if (!ID_PATTERN.test(value)) {
    return false;
  }
  return value.split('-').length >= MIN_ID_SEGMENTS;
}

// ---- 型 ----

/** build の進捗。ticket が1件も無い build はこのフィールド自体を持たない（0/0 とは書かない）。 */
export interface BuildProgress {
  readonly done: number;
  readonly total: number;
}

/**
 * build の状態。チケットからは判定できないため宣言する。
 * state は語彙、text はなぜその状態なのかの説明。
 */
export interface BuildStatus {
  readonly state: BuildState;
  readonly text: string;
}

export interface Build {
  readonly id: string;
  readonly name: string;
  /**
   * 観測できる結果の列。build が達成されたかを判定する単位で、ticket はこの1つを指す。
   * 分割力の源: 散文1本だと継ぎ目が無く、ticket が build と1:1に collapse する。
   */
  readonly verify: readonly string[];
  readonly uses: readonly string[];
  readonly progress?: BuildProgress;
  readonly status: BuildStatus;
}

export interface Spec {
  readonly name: string;
  readonly goal: readonly string[];
  readonly nongoal: readonly string[];
  readonly build: readonly Build[];
}

/** 検証結果。問題が1件でもあれば spec は undefined になる。 */
export interface SpecValidation {
  readonly spec: Spec | undefined;
  readonly issues: readonly Issue[];
}

export function isSpecType(value: unknown): value is SpecType {
  return isMemberOf(SPEC_TYPES, value);
}

// ---- フィールド単位の読み取り ----

/**
 * 観測できる結果の列を読む。空を許さず、同一 build 内の重複も弾く。
 * 条件は ticket から文字列で参照されるので、重複すると指す先が決まらない。
 */
function readConditions(input: unknown, label: string, issues: Issue[]): string[] | undefined {
  const values = readStringArray(input, label, issues);
  if (values === undefined) {
    return undefined;
  }
  if (values.length === 0) {
    issues.push({ path: label, message: 'verify には最低1つの条件が必要です' });
    return undefined;
  }
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      issues.push({ path: `${label}[${index}]`, message: `条件が重複しています: ${value}` });
      continue;
    }
    seen.add(value);
  }
  return values;
}

function readBuildId(input: unknown, label: string, issues: Issue[]): string | undefined {
  const value = readString(input, label, issues);
  if (value === undefined) {
    return undefined;
  }
  if (!isValidBuildId(value)) {
    issues.push({
      path: label,
      message: `id の形式が不正です: ${value}。小文字とハイフンで2セグメント以上（先頭は種別）。${BUILD_ID_HINT}`,
    });
    return undefined;
  }
  return value;
}

/** status は宣言値。語彙内であることと text が空でないことだけを検証する。 */
function readStatus(input: unknown, label: string, issues: Issue[]): BuildStatus | undefined {
  if (!isRecord(input)) {
    issues.push({ path: label, message: 'オブジェクトである必要があります' });
    return undefined;
  }
  rejectUnknownKeys(input, ['state', 'text'], label, issues);
  if (!isMemberOf(BUILD_STATES, input.state)) {
    issues.push({
      path: `${label}.state`,
      message: `次のいずれかである必要があります: ${BUILD_STATES.join(', ')}`,
    });
    return undefined;
  }
  const text = readString(input.text, `${label}.text`, issues);
  return text === undefined ? undefined : { state: input.state, text };
}

function readProgress(input: unknown, label: string, issues: Issue[]): BuildProgress | undefined {
  // フィールドごと省略されている状態が「ticket 0件」を意味する
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    issues.push({ path: label, message: 'オブジェクトである必要があります' });
    return undefined;
  }
  rejectUnknownKeys(input, ['done', 'total'], label, issues);
  const done = readCount(input.done, `${label}.done`, issues);
  const total = readCount(input.total, `${label}.total`, issues);
  if (done === undefined || total === undefined) {
    return undefined;
  }
  if (total === 0) {
    issues.push({
      path: label,
      message: 'ticket が0件の build は progress を持ちません。フィールドごと省略してください',
    });
    return undefined;
  }
  if (done > total) {
    issues.push({ path: `${label}.done`, message: 'total 以下である必要があります' });
    return undefined;
  }
  return { done, total };
}

// ---- build / spec の検証 ----

const BUILD_KEYS = ['id', 'name', 'verify', 'uses', 'progress', 'status'] as const;

function readBuild(input: unknown, label: string, issues: Issue[]): Build | undefined {
  if (!isRecord(input)) {
    issues.push({ path: label, message: 'オブジェクトである必要があります' });
    return undefined;
  }
  rejectUnknownKeys(input, BUILD_KEYS, label, issues);
  const id = readBuildId(input.id, `${label}.id`, issues);
  const name = readString(input.name, `${label}.name`, issues);
  const verify = readConditions(input.verify, `${label}.verify`, issues);
  const uses = readStringArray(input.uses, `${label}.uses`, issues);

  const beforeProgress = issues.length;
  const progress = readProgress(input.progress, `${label}.progress`, issues);
  const progressOk = issues.length === beforeProgress;

  const beforeStatus = issues.length;
  const status = readStatus(input.status, `${label}.status`, issues);
  const statusOk = issues.length === beforeStatus;

  if (id === undefined || name === undefined || verify === undefined || uses === undefined) {
    return undefined;
  }
  if (!progressOk || !statusOk || status === undefined) {
    return undefined;
  }
  return {
    id,
    name,
    verify,
    uses,
    ...(progress === undefined ? {} : { progress }),
    status,
  };
}

function readBuildList(input: unknown, label: string, issues: Issue[]): Build[] | undefined {
  if (!Array.isArray(input)) {
    issues.push({ path: label, message: '配列である必要があります' });
    return undefined;
  }
  const builds: Build[] = [];
  const seen = new Set<string>();
  for (const [index, item] of input.entries()) {
    const itemLabel = `${label}[${index}]`;
    const build = readBuild(item, itemLabel, issues);
    if (build === undefined) {
      continue;
    }
    if (seen.has(build.id)) {
      issues.push({ path: `${itemLabel}.id`, message: `id が重複しています: ${build.id}` });
      continue;
    }
    seen.add(build.id);
    builds.push(build);
  }
  return builds;
}

/**
 * uses の参照を検証する。
 * build は削除しない方針なので、参照切れは常に異常として弾く。
 */
function validateReferences(builds: readonly Build[], label: string, issues: Issue[]): void {
  const ids = new Set(builds.map((build) => build.id));
  for (const [index, build] of builds.entries()) {
    for (const [usedIndex, used] of build.uses.entries()) {
      const path = `${label}.build[${index}].uses[${usedIndex}]`;
      if (used === build.id) {
        issues.push({ path, message: '自分自身を参照しています' });
      } else if (!ids.has(used)) {
        issues.push({ path, message: `存在しない build を参照しています: ${used}` });
      }
    }
  }
}

/**
 * その build を参照している build の id を返す。
 * 削除の可否判定に使う（参照が1つでもあれば消せない）。
 * チケットが入ったら、open なチケットの targets もここに加える。
 */
export function referencingBuilds(spec: Spec, id: string): string[] {
  return spec.build.filter((build) => build.uses.includes(id)).map((build) => build.id);
}

/** 任意の入力を検証して Spec にする。問題は全件集めて返す。 */
export function parseSpec(input: unknown, label: string): SpecValidation {
  if (!isRecord(input)) {
    return {
      spec: undefined,
      issues: [{ path: label, message: 'オブジェクトである必要があります' }],
    };
  }
  const issues: Issue[] = [];
  rejectUnknownKeys(input, ['name', 'goal', 'nongoal', 'build'], label, issues);
  const name = readString(input.name, `${label}.name`, issues);
  const goal = readStringArray(input.goal, `${label}.goal`, issues);
  const nongoal = readStringArray(input.nongoal, `${label}.nongoal`, issues);
  const build = readBuildList(input.build, `${label}.build`, issues);

  if (name === undefined || goal === undefined || nongoal === undefined || build === undefined) {
    return { spec: undefined, issues };
  }
  validateReferences(build, label, issues);
  if (issues.length > 0) {
    return { spec: undefined, issues };
  }
  return { spec: { name, goal, nongoal, build }, issues };
}

// ---- パスとバージョン ----

/** バージョンはファイル名が唯一の真実。3桁ゼロ埋めで辞書順と数値順を一致させる。 */
export function formatVersion(version: number): string {
  return `v${String(version).padStart(3, '0')}`;
}

function parseVersion(fileName: string): number | undefined {
  const matched = /^v(\d+)\.json$/.exec(fileName);
  return matched === null ? undefined : Number(matched[1]);
}

export function specTypeDir(root: string, specType: SpecType): string {
  return join(root, 'spec', specType);
}

export function versionFile(root: string, specType: SpecType, version: number): string {
  return join(specTypeDir(root, specType), `${formatVersion(version)}.json`);
}

/** 存在するバージョンを数値昇順で返す。 */
export async function listVersions(root: string, specType: SpecType): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(specTypeDir(root, specType));
  } catch {
    return [];
  }
  return entries
    .map(parseVersion)
    .filter((version): version is number => version !== undefined)
    .toSorted((a, b) => a - b);
}

/** 現行版は数値最大のバージョン。履歴はファイルとして残るが、更新対象は常に現行版。 */
export async function currentVersion(root: string, specType: SpecType): Promise<number> {
  const latest = (await listVersions(root, specType)).at(-1);
  if (latest === undefined) {
    throw new DocumentError(`spec/${specType}/ にバージョンファイルがありません`);
  }
  return latest;
}

// ---- 読み書き ----

/** 指定バージョン（省略時は現行版）を読み、検証して返す。 */
export async function readSpec(root: string, specType: SpecType, version?: number): Promise<Spec> {
  const resolved = version ?? (await currentVersion(root, specType));
  const file = versionFile(root, specType, resolved);
  const label = `${specType}/${formatVersion(resolved)}.json`;
  const { spec, issues } = parseSpec(await readJson(file), label);
  if (spec === undefined) {
    throw new DocumentError(formatIssues(file, issues));
  }
  return spec;
}

/**
 * 検証してから書き込む。検証を通らない入力はファイルに到達しない。
 * status は宣言値なのでそのまま保存する（導出による上書きはしない）。
 */
export async function writeSpec(
  root: string,
  specType: SpecType,
  version: number,
  spec: unknown,
): Promise<string> {
  const label = `${specType}/${formatVersion(version)}.json`;
  const file = versionFile(root, specType, version);
  const { spec: validated, issues } = parseSpec(spec, label);
  if (validated === undefined) {
    throw new DocumentError(formatIssues(file, issues));
  }
  return writeJson(file, validated);
}

/** messageOf を再輸出する（CLI が例外を1行にするために使う）。 */
export { messageOf };
