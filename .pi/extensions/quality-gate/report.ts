import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from '@earendil-works/pi-coding-agent';

/** 1 つのチェックの実行結果 */
export interface CheckOutcome {
  readonly label: string;
  readonly failed: boolean;
  readonly output: string;
}

/** チェック実行の結果と、実際に検査したファイル */
export interface CheckRun {
  readonly outcomes: readonly CheckOutcome[];
  /** 検査対象から外れたファイル（削除済み、または git 管理外） */
  readonly skipped: readonly string[];
}

/** 失敗レポートを組み立てるための入力 */
export interface GateFailureReport {
  readonly outcomes: readonly CheckOutcome[];
  readonly attempt: number;
  readonly maxAttempts: number;
  /** 編集されたファイル（相対パス） */
  readonly relativePaths: readonly string[];
  /** 検査対象から外れたファイル（相対パス） */
  readonly skippedPaths: readonly string[];
  readonly isFinalAttempt: boolean;
}

/** 長すぎる出力を切り詰める（エラーは先頭に並ぶため head を残す） */
function clipOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '(no output)';
  }

  const result = truncateHead(trimmed, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!result.truncated) {
    return result.content;
  }

  const omitted = result.totalLines - result.outputLines;
  return `${result.content}\n[output truncated: ${omitted} more line(s) omitted]`;
}

function formatCheckSection(outcome: CheckOutcome): string {
  const status = outcome.failed ? 'FAILED' : 'ok';
  if (!outcome.failed) {
    return `### ${outcome.label}: ${status}`;
  }
  return `### ${outcome.label}: ${status}\n\`\`\`\n${clipOutput(outcome.output)}\n\`\`\``;
}

function formatTouched(report: GateFailureReport): string {
  const lines: string[] = [];
  if (report.relativePaths.length > 0) {
    lines.push('Files touched in this turn:', ...report.relativePaths);
  }
  if (report.skippedPaths.length > 0) {
    lines.push('', 'Skipped (deleted or git-ignored, not checked):', ...report.skippedPaths);
  }
  if (lines.length === 0) {
    lines.push('Files touched in this turn: (none)');
  }
  return lines.join('\n');
}

/**
 * LLM に渡す修復指示メッセージを組み立てる。
 * エージェント向けの文面なので英語で書く（日本語コメントは人間向けの補足）。
 */
export function buildGateMessage(report: GateFailureReport): string {
  const failedLabels = report.outcomes
    .filter((outcome) => outcome.failed)
    .map((outcome) => outcome.label)
    .join(', ');

  const header = report.isFinalAttempt
    ? `[quality-gate] Final attempt (${report.attempt}/${report.maxAttempts}). These checks still fail: ${failedLabels}.`
    : `[quality-gate] Automatic checks failed (attempt ${report.attempt}/${report.maxAttempts}): ${failedLabels}.`;

  const body = report.outcomes.map(formatCheckSection).join('\n\n');

  const instructions = [
    'Fix the problems reported above.',
    'Run the checks yourself if you need more detail:',
    '  pnpm format / pnpm lint / pnpm typecheck:staged <files>',
    'Do not weaken, disable, or reconfigure the checks themselves.',
    'Do not delete the offending file just to make the checks pass - fix the real problem.',
    report.isFinalAttempt
      ? 'This is the last automatic retry. If it still fails, stop and report the remaining problems to the user.'
      : 'The full check suite runs again automatically after your next turn.',
  ].join('\n');

  return [header, '', formatTouched(report), '', body, '', instructions].join('\n');
}
