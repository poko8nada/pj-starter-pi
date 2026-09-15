import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// ドキュメント（spec と tickets）に共通する語彙・ガード・I/O。
// ここには「どのドキュメントにも当てはまるもの」だけを置く。
// spec 固有の形は schema.ts、ticket 固有の形は ticket.ts、両方をまたぐ検証は store.ts。

/** 検証で見つかった問題。path は JSON 内の位置、message はなぜ駄目か。 */
export interface Issue {
  readonly path: string;
  readonly message: string;
}

/** 検証に失敗したことを利用者に伝えるためのエラー。 */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

/** 例外を1行のメッセージに正規化する。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/** 語彙（as const 配列）に含まれるかを判定する。型と実行時検証の両方をここから導く。 */
export function isMemberOf<T extends string>(values: readonly T[], input: unknown): input is T {
  return typeof input === 'string' && (values as readonly string[]).includes(input);
}

/** 未知のフィールドを弾く。書かれてはいけないものが静かに残るのを防ぐ。 */
export function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: Issue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      issues.push({
        path: `${label}.${key}`,
        message: `未知のフィールドです。許可: ${allowed.join(', ')}`,
      });
    }
  }
}

/**
 * 文字列を読む。前後の空白は落とす（trim は半角・全角・タブ・改行・NBSP をすべて落とす）。
 * 内部の空白は残す（書き手の意図かもしれないので潰さない）。
 * 正規化はここだけで行い、読み込み時はファイルの値をそのまま使う。
 */
export function readString(input: unknown, label: string, issues: Issue[]): string | undefined {
  if (typeof input !== 'string') {
    issues.push({ path: label, message: '文字列である必要があります' });
    return undefined;
  }
  const value = input.trim();
  if (value === '') {
    // 空白だけの値は「書き忘れ」と区別できないため弾く。空配列は許す。
    issues.push({ path: label, message: '空文字は許可されません' });
    return undefined;
  }
  return value;
}

/** 文字列の配列を読む。空配列は許す（「無し」という回答になる）。 */
export function readStringArray(
  input: unknown,
  label: string,
  issues: Issue[],
): string[] | undefined {
  if (!Array.isArray(input)) {
    issues.push({ path: label, message: '配列である必要があります' });
    return undefined;
  }
  const values: string[] = [];
  for (const [index, item] of input.entries()) {
    const value = readString(item, `${label}[${index}]`, issues);
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

/** 0 以上の整数を読む。 */
export function readCount(input: unknown, label: string, issues: Issue[]): number | undefined {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) {
    issues.push({ path: label, message: '0 以上の整数である必要があります' });
    return undefined;
  }
  return input;
}

/** 検証エラーを、ファイルパスと問題の一覧として整形する。 */
export function formatIssues(file: string, issues: readonly Issue[]): string {
  const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`);
  return `${file}\n${lines.join('\n')}`;
}

// ---- I/O ----

export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new DocumentError(`読み込めません: ${file} (${messageOf(error)})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DocumentError(`${file} が JSON として読めません: ${messageOf(error)}`);
  }
}

/** 整形して書き出す。末尾に改行を入れて、diff が最終行で汚れないようにする。 */
export async function writeJson(file: string, value: unknown): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}
