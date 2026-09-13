import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CheckOutcome, CheckRun } from './report.ts';
import { filterByExtensions } from './targets.ts';

/** 自動修正フェーズか検証フェーズか */
type Phase = 'fix' | 'verify';

/** 1 つのチェック定義（配列順に実行する） */
interface CheckSpec {
  readonly phase: Phase;
  readonly label: string;
  readonly script: string;
  /** スクリプトへ渡す固定フラグ。対象パスはこの後ろに連結される */
  readonly flags: readonly string[];
  readonly kind: 'format' | 'lint' | 'typecheck';
}

/**
 * 2 フェーズ構成。配列順に実行する。
 *
 * フェーズ1（自動修正・失敗しても続行）:
 *   意味を変えないと証明できる変換のみ適用する。`curly` や `prefer-const` は直るが、
 *   `eqeqeq` や `no-unused-vars` のような意味判断が要るものは触られない。
 *   oxlint --fix は `{return 1;}` のように波括弧を崩すため、直後の format が必須。
 *
 * フェーズ2（検証・ここで失敗を報告）:
 *   自動修正で直りきらなかった分だけを検出して LLM に渡す。
 */
const CHECK_SPECS: readonly CheckSpec[] = [
  {
    phase: 'fix',
    label: 'lint:fix',
    script: 'lint:fix',
    // 対象が ignore された場合の "No files found" を無害化する
    flags: ['--no-error-on-unmatched-pattern'],
    kind: 'lint',
  },
  {
    phase: 'fix',
    label: 'format',
    script: 'format',
    // 対象が ignore された場合に oxfmt が exit 2 で落ちるのを防ぐ
    flags: ['--no-error-on-unmatched-pattern'],
    kind: 'format',
  },
  {
    phase: 'verify',
    label: 'lint',
    script: 'lint',
    flags: ['--no-error-on-unmatched-pattern'],
    kind: 'lint',
  },
  { phase: 'verify', label: 'typecheck', script: 'typecheck:staged', flags: [], kind: 'typecheck' },
];

export function toRelative(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel === '' ? path : rel;
}

/**
 * チェック対象を確定する。
 * - 削除済みファイルは除外する（存在しないパスを渡すとツールが異常終了する）
 * - git 管理外（.gitignore 対象）も除外する（dist/ などで「対象なし」の誤検知になる）
 */
async function prepareTargets(
  pi: ExtensionAPI,
  cwd: string,
  paths: readonly string[],
): Promise<{ checked: string[]; skipped: string[] }> {
  const existing = paths.filter((path) => existsSync(path));
  const deleted = paths.filter((path) => !existing.includes(path));
  if (existing.length === 0) {
    return { checked: [], skipped: deleted };
  }

  const result = await pi.exec('git', ['check-ignore', '--', ...existing], { cwd });
  if (result.code !== 0) {
    // exit 1 = 無視されたファイルなし、128 = git 管理外。どちらも「除外なし」で扱う
    return { checked: existing, skipped: deleted };
  }

  const ignored = new Set(result.stdout.split('\n').filter((line) => line !== ''));
  return {
    checked: existing.filter((path) => !ignored.has(path)),
    skipped: [...deleted, ...existing.filter((path) => ignored.has(path))],
  };
}

/** 1 つのチェックを実行する。対象が無い場合は undefined を返す */
async function runCheck(
  pi: ExtensionAPI,
  cwd: string,
  spec: CheckSpec,
  checked: readonly string[],
): Promise<CheckOutcome | undefined> {
  const paths = spec.kind === 'typecheck' ? checked : filterByExtensions(checked, spec.kind);
  if (spec.kind !== 'typecheck' && paths.length === 0) {
    // 対象拡張子なし。ツールが「対象なし」で異常終了するのを避けてスキップする
    return undefined;
  }

  const result = await pi.exec('pnpm', ['run', spec.script, ...spec.flags, ...paths], { cwd });
  return {
    label: spec.label,
    failed: result.code !== 0,
    output: [result.stdout, result.stderr].filter((text) => text !== '').join('\n'),
  };
}

/**
 * 自動修正 → 検証の順に対象ファイルをチェックする。
 *
 * 自動修正フェーズの終了コードは無視する。修正しきれない違反が残ると非ゼロで終わるが、
 * それは想定内であり、直後に検証フェーズが同じ内容を報告する。
 * ツール自体の異常（設定破損など）も検証フェーズで検出される。
 */
export async function runChecks(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targets: readonly string[],
): Promise<CheckRun> {
  const { checked, skipped } = await prepareTargets(pi, ctx.cwd, targets);
  const outcomes: CheckOutcome[] = [];

  for (const spec of CHECK_SPECS) {
    // oxlint-disable-next-line no-await-in-loop -- 修正結果を検証するため順序が必須
    const outcome = await runCheck(pi, ctx.cwd, spec, checked);
    if (outcome === undefined) {
      continue;
    }
    if (spec.phase === 'verify') {
      outcomes.push(outcome);
    }
  }

  return { outcomes, skipped };
}
