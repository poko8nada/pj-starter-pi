import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/** 通知の種類。3種類で音と文言を出し分ける */
type NotifyKind = 'permission' | 'question' | 'done';

interface SoundNotifyConfig {
  enabled: boolean;
  /** 種類ごとのシステムサウンド名（/System/Library/Sounds/<name>.aiff） */
  sounds: Record<NotifyKind, string>;
  /** cmux への通知を送るか */
  notifications: boolean;
}

const DEFAULT_CONFIG: SoundNotifyConfig = {
  enabled: true,
  sounds: { permission: 'Blow', question: 'Ping', done: 'Glass' },
  notifications: true,
};

const SOUNDS_DIR = '/System/Library/Sounds';
const NOTIFICATION_TITLE = 'pi';

/**
 * cmux の通知文言。
 * subtitle で種類を出し分け、body は「何を待っているか」が分かる文にする。
 */
const NOTIFICATION_COPY: Record<NotifyKind, { subtitle: string; body: string }> = {
  permission: { subtitle: 'Permission', body: 'Approval needed' },
  question: { subtitle: 'Question', body: 'Agent is waiting for your answer' },
  done: { subtitle: 'Done', body: 'Turn complete' },
};

/** 設定ファイルは拡張と同じディレクトリに置く（ローカル/グローバルどちらでも解決できる） */
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseConfig(parsed: unknown): SoundNotifyConfig {
  if (!isRecord(parsed)) {
    return DEFAULT_CONFIG;
  }

  const sounds = isRecord(parsed.sounds) ? parsed.sounds : {};
  return {
    enabled: readBoolean(parsed.enabled, DEFAULT_CONFIG.enabled),
    notifications: readBoolean(parsed.notifications, DEFAULT_CONFIG.notifications),
    sounds: {
      permission: readString(sounds.permission, DEFAULT_CONFIG.sounds.permission),
      question: readString(sounds.question, DEFAULT_CONFIG.sounds.question),
      done: readString(sounds.done, DEFAULT_CONFIG.sounds.done),
    },
  };
}

function loadConfig(): SoundNotifyConfig {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }
  try {
    return parseConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    // 壊れた設定で通知が止まるより、既定値で鳴らし続ける方が安全
    return DEFAULT_CONFIG;
  }
}

/**
 * 入力待ちの種類を判定する。
 * permission 系のダイアログは title が "Permission Required\n..." で始まるため、
 * それ以外（通常の質問・確認ダイアログ）は question として扱う。
 */
function classify(title: string | undefined): NotifyKind {
  return title !== undefined && /permission/i.test(title) ? 'permission' : 'question';
}

async function playSound(pi: ExtensionAPI, soundName: string): Promise<void> {
  await pi.exec('afplay', [`${SOUNDS_DIR}/${soundName}.aiff`]);
}

async function sendNotification(pi: ExtensionAPI, kind: NotifyKind): Promise<void> {
  const copy = NOTIFICATION_COPY[kind];
  await pi.exec('cmux', [
    'notify',
    '--title',
    NOTIFICATION_TITLE,
    '--subtitle',
    copy.subtitle,
    '--body',
    copy.body,
  ]);
}

function dispatch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  kind: NotifyKind,
  config: SoundNotifyConfig,
): void {
  // print / JSON モードには端末が無いため鳴らさない（CI やパイプ実行での誤爆を防ぐ）
  if (!config.enabled || !ctx.hasUI) {
    return;
  }

  const tasks: Promise<void>[] = [playSound(pi, config.sounds[kind])];
  if (config.notifications) {
    tasks.push(sendNotification(pi, kind));
  }

  // 通知の完了を待つと pi がアイドルに戻るタイミングが遅れるため投げっぱなしにする。
  // afplay / cmux は失敗しても exec が reject しないが、念のため握りつぶす。
  Promise.all(tasks).catch(() => undefined);
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  // 入力待ち: エージェントが止まってユーザーの答えを待っている（緊急度が高い）
  pi.on('ui_prompt_start', async (event, ctx) => {
    dispatch(pi, ctx, classify(event.title), config);
  });

  // ターン完了: エージェントが仕事を終えた（報告）
  pi.on('agent_settled', async (_event, ctx) => {
    dispatch(pi, ctx, 'done', config);
  });
}
