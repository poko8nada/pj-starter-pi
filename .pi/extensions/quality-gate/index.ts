import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { runChecks, toRelative } from './checks.ts';
import type { CheckRun } from './report.ts';
import { buildGateMessage } from './report.ts';

/**
 * 1 ターンで自動チェックをやり直せる回数の上限。
 * 無限ループを避けるため、超えたらユーザーに報告して打ち切る。
 */
const MAX_ATTEMPTS = 3;

/** メッセージ内で使う識別子 */
const GATE_CUSTOM_TYPE = 'quality-gate';

/** チェック対象にする編集系ツール */
const MUTATING_TOOLS = new Set(['edit', 'write']);

/** ターンをまたいで持ち越す状態 */
interface GateState {
  /** 今回の run で編集されたファイル（絶対パス） */
  touched: Set<string>;
  /** 直近でチェックしたファイル。エージェントが何も編集しなかった場合の再チェックに使う */
  pendingFiles: string[];
  /** 自動チェックの連続失敗回数 */
  attempts: number;
  /** 実行中ガード（agent_end の多重実行を防ぐ） */
  running: boolean;
}

function createState(): GateState {
  return { touched: new Set(), pendingFiles: [], attempts: 0, running: false };
}

function resetAttempts(state: GateState): void {
  state.attempts = 0;
  state.pendingFiles = [];
}

/** ツール呼び出しから対象ファイルパスを取り出す（edit/write はいずれも path を持つ） */
function extractPath(input: Record<string, unknown>): string | undefined {
  const path = input.path;
  return typeof path === 'string' && path !== '' ? path : undefined;
}

/** 例外を 1 行のメッセージに正規化する */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** event.messages の最後の assistant メッセージから stopReason を取り出す */
function lastStopReason(event: AgentEndEvent): string | undefined {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'assistant' &&
      'stopReason' in message &&
      typeof message.stopReason === 'string'
    ) {
      return message.stopReason;
    }
  }
  return undefined;
}

/**
 * 途中終了した run ではゲートを動かさない。
 * stopReason "error" / "aborted" はモデル側の失敗やユーザーの中断であり、
 * 修正指示を積んでも解決せず、エラーを繰り返すだけになる。
 */
function isInterrupted(event: AgentEndEvent): boolean {
  const stopReason = lastStopReason(event);
  return stopReason === 'error' || stopReason === 'aborted';
}

/** 次にチェックすべきファイルを決める */
function resolveTargets(state: GateState, edited: readonly string[]): string[] {
  // エージェントが何も編集しなかった場合は前回と同じ対象を再チェックする。
  // ここで諦めると上限回数に達する前に黙って止まってしまう。
  return edited.length > 0 ? [...edited] : state.pendingFiles;
}

/** 失敗通知に必要な情報をまとめた入力 */
interface FailureInput {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly state: GateState;
  readonly files: readonly string[];
  readonly run: CheckRun;
}

/** 失敗内容を LLM に followUp として渡し、修正ターンを起こす */
function reportFailure({ pi, ctx, state, files, run }: FailureInput): void {
  state.attempts += 1;
  // 次ターンでエージェントが何も編集しなかった場合、同じ対象を再チェックできるように保持する
  state.pendingFiles = [...files];
  const { outcomes, skipped } = run;
  const failed = outcomes.filter((outcome) => outcome.failed);
  const isFinalAttempt = state.attempts >= MAX_ATTEMPTS;
  const toRel = (file: string) => toRelative(ctx.cwd, file);

  pi.sendMessage(
    {
      customType: GATE_CUSTOM_TYPE,
      content: buildGateMessage({
        outcomes,
        attempt: state.attempts,
        maxAttempts: MAX_ATTEMPTS,
        relativePaths: files.map(toRel),
        skippedPaths: skipped.map(toRel),
        isFinalAttempt,
      }),
      display: true,
      details: {
        attempt: state.attempts,
        maxAttempts: MAX_ATTEMPTS,
        failed: failed.map((outcome) => outcome.label),
      },
    },
    { triggerTurn: true, deliverAs: 'followUp' },
  );

  if (isFinalAttempt) {
    const labels = failed.map((outcome) => outcome.label).join(', ');
    ctx.ui.notify(
      `quality-gate: still failing after ${MAX_ATTEMPTS} attempts (${labels}). Stopping automatic retries.`,
      'error',
    );
    // 未解決のまま打ち切った内容をセッションに残す（後から追跡できるように）
    pi.appendEntry('quality-gate-unresolved', {
      attempts: state.attempts,
      failed: failed.map((outcome) => outcome.label),
      files: files.map(toRel),
    });
    resetAttempts(state);
  }
}

/** チェックを実行し、必要なら修正指示を送る */
async function runGate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: GateState,
  files: readonly string[],
): Promise<void> {
  const run = await runChecks(pi, ctx, files);
  if (run.outcomes.every((outcome) => !outcome.failed)) {
    resetAttempts(state);
    if (ctx.hasUI) {
      const labels = run.outcomes.map((outcome) => outcome.label).join(', ');
      ctx.ui.notify(`quality-gate: ${labels} passed`, 'info');
    }
    return;
  }

  reportFailure({ pi, ctx, state, files, run });
}

/** agent_end での 1 回分の処理 */
async function handleAgentEnd(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: GateState,
  event: AgentEndEvent,
): Promise<void> {
  if (state.running) {
    return;
  }

  const edited = [...state.touched];
  state.touched = new Set();
  const files = resolveTargets(state, edited);

  if (files.length === 0 || isInterrupted(event)) {
    resetAttempts(state);
    return;
  }

  state.running = true;
  try {
    await runGate(pi, ctx, state, files);
  } catch (error) {
    ctx.ui.notify(`quality-gate: check execution failed: ${errorMessage(error)}`, 'error');
    resetAttempts(state);
  } finally {
    state.running = false;
  }
}

export default function (pi: ExtensionAPI) {
  const state = createState();

  pi.on('session_start', async () => {
    Object.assign(state, createState());
  });

  // ユーザーが新しく入力した時点でリセットする。
  // 拡張自身の sendMessage は source: "extension" なのでここには来ない。
  pi.on('input', async (event) => {
    if (event.source !== 'extension') {
      resetAttempts(state);
    }
  });

  // agent_end の messages にはツール入力が含まれないため、ここで収集する
  pi.on('tool_result', async (event) => {
    if (!MUTATING_TOOLS.has(event.toolName) || event.isError) {
      return;
    }
    const path = extractPath(event.input);
    if (path !== undefined) {
      state.touched.add(path);
    }
  });

  // agent_settled から送ると 2 周目で extension ctx が stale になるため agent_end を使う。
  // この時点の isIdle() は false で、followUp として積むのが正しい振る舞い。
  pi.on('agent_end', async (event, ctx) => {
    await handleAgentEnd(pi, ctx, state, event);
  });

  // 打ち切った後に未解決のまま残った内容を記録する（監査用）。
  // 通常の打ち切り時は reportFailure で即時記録するため、ここは中断・終了時の取りこぼしを拾う。
  pi.on('session_shutdown', async () => {
    if (state.pendingFiles.length > 0 && state.attempts > 0) {
      pi.appendEntry('quality-gate-unresolved', {
        attempts: state.attempts,
        files: state.pendingFiles,
      });
    }
  });

  pi.registerCommand('quality-gate', {
    description: 'Run format, lint, and typecheck on the files touched in this session',
    handler: async (_args, ctx) => {
      const files = [...state.touched];
      if (files.length === 0) {
        ctx.ui.notify('quality-gate: no files touched yet in this session', 'warning');
        return;
      }

      const run = await runChecks(pi, ctx, files);
      const lines = run.outcomes.map(
        (outcome) => `${outcome.failed ? 'FAIL' : 'ok  '} ${outcome.label}`,
      );
      const hasFailure = run.outcomes.some((outcome) => outcome.failed);
      ctx.ui.notify(`quality-gate:\n${lines.join('\n')}`, hasFailure ? 'error' : 'info');
    },
  });
}
