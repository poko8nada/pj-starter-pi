import { parseArgs } from 'node:util';
import { DocumentError, formatIssues } from './document.ts';
import {
  BUILD_ID_HINT,
  BUILD_STATES,
  canTransition,
  formatVersion,
  isSpecType,
  isValidBuildId,
  TRANSITION_RULE,
  type BuildState,
  type Spec,
  type SpecType,
} from './schema.ts';
import { validateCandidate, type Snapshot } from './store.ts';

// 引数の解釈と、フラグ単位の検証。
// 「値が語彙に入っているか」「必須か」をここで確定させ、コマンド側は検証済みの値だけを扱う。
// 早期に失敗させるのは、エラーを JSON のパスではなく打ったフラグ名で伝えるため。

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** parseArgs が返す値。--verify 等は複数指定でき、--all は真偽値になる。 */
type OptionValue = string | string[] | boolean | undefined;

export interface Options {
  readonly root: string;
  readonly specType: SpecType;
  readonly version: number | undefined;
  readonly values: Record<string, OptionValue>;
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

export function parseOptions(args: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...args],
    options: {
      type: { type: 'string' },
      version: { type: 'string' },
      root: { type: 'string' },
      to: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      verify: { type: 'string', multiple: true },
      uses: { type: 'string' },
      state: { type: 'string' },
      text: { type: 'string' },
      build: { type: 'string', multiple: true },
      condition: { type: 'string', multiple: true },
      title: { type: 'string' },
      status: { type: 'string' },
      all: { type: 'boolean' },
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
export function has(options: Options, key: string): boolean {
  const value = options.values[key];
  return value !== undefined && value !== false;
}

/**
 * 必須フラグを読む。trim は schema でも行われるが、ここで先に行うことで
 * 空白だけの入力をフラグ名付きで弾ける（JSON のパスではなく、打った語で伝える）。
 */
export function requireValue(options: Options, key: string, flag: string): string {
  const value = options.values[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${flag} は必須です`);
  }
  return value.trim();
}

/**
 * 必須のフラグを、複数指定不可の単一値として読む。
 * --verify は build では列（複数可）だが ticket では単一なので、同じ名前でも扱いが違う。
 * 配列で来た場合は1つだけ許す。
 */
export function requireSingleValue(options: Options, key: string, flag: string): string {
  const value = options.values[key];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      fail(`${flag} は1回だけ指定できます`);
    }
    const [only] = value;
    if (typeof only !== 'string' || only.trim() === '') {
      fail(`${flag} は必須です`);
    }
    return only.trim();
  }
  return requireValue(options, key, flag);
}

/** 真偽値フラグ（--all など）。 */
export function readFlag(options: Options, key: string): boolean {
  return options.values[key] === true;
}

/**
 * --verify の列を読む。--verify を繰り返して指定する。
 * カンマで区切らないのは、条件の文に読点が入りうるため。
 * trim は schema でも行われるが、ここで先に正規化して重複の早期検出と
 * 空白だけの入力を正しく弾けるようにする。
 */
export function readVerify(options: Options, flag: string): string[] {
  const value = options.values.verify;
  const list = asStringList(value);
  const conditions = list.map((item) => item.trim()).filter((item) => item !== '');
  if (conditions.length === 0) {
    fail(`${flag} を1つ以上指定してください（--verify を繰り返す）`);
  }
  return conditions;
}

/** フラグの値を文字列の配列に正規化する（未指定・単一・複数のいずれでも）。 */
export function asStringList(value: OptionValue): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === 'string' ? [value] : [];
}
/**
 * 単一値のフラグを読む。--verify だけが複数指定を許すので、他のフラグに配列が来たら入口で拒否する。
 */
export function single(options: Options, key: string): string | undefined {
  const value = options.values[key];
  if (Array.isArray(value)) {
    fail(`--${key} は1回だけ指定できます`);
  }
  return typeof value === 'string' ? value : undefined;
}

/** --state の値を語彙に突き合わせる。 */
export function readState(raw: string | undefined): BuildState {
  const matched = BUILD_STATES.find((state) => state === raw);
  if (matched === undefined) {
    fail(`--state は次のいずれかです: ${BUILD_STATES.join(', ')}（受け取った値: ${raw}）`);
  }
  return matched;
}

/**
 * --id の形を検証する。schema と同じ基準を入口でも適用して早く失敗させる。
 * trim も schema と同じ基準で先に行う。ここで揃えないと、同じ入力の扱いが
 * 経路によって変わる（CLI では弾かれ、schema では通る）。
 */
export function readId(options: Options, key: string, flag: string): string {
  const value = requireValue(options, key, flag);
  if (!isValidBuildId(value)) {
    fail(
      `${flag} の形式が不正です: ${value || '(空)'}\n  小文字とハイフンで2セグメント以上（先頭は種別）。${BUILD_ID_HINT}`,
    );
  }
  return value;
}

export function readUses(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

/**
 * status の遷移制約。単体では判定できないので CLI 層に置く。
 * 規則は schema.ts の canTransition が持つ（型と語彙と同じ場所に集約する）。
 */
export function assertTransition(from: BuildState, to: BuildState): void {
  if (canTransition(from, to)) {
    return;
  }
  fail(`state を ${from} から planned には戻せません（${from} -> ${to}）\n  ${TRANSITION_RULE}`);
}

/**
 * 書き込み前の候補 spec がチケットと整合するかを確かめる。
 * 現行版を触るときだけ意味がある（過去版はチケットと一致しなくてよい）。
 */
export function assertCandidateAcceptable(snapshot: Snapshot, spec: Spec): void {
  const issues = validateCandidate(snapshot, spec);
  if (issues.length > 0) {
    throw new DocumentError(
      formatIssues(`spec/${snapshot.specType}/${formatVersion(snapshot.version)}.json`, issues),
    );
  }
}
