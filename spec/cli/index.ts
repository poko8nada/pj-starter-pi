import { DocumentError, messageOf } from '../lib/document.ts';
import { parseOptions } from './args.ts';
import { runBuildAdd, runBuildRemove, runBuildRename, runBuildSet } from './build.ts';
import { USAGE } from './shared.ts';
import { runTicketAdd, runTicketList, runTicketRemove, runTicketSet } from './ticket.ts';
import { runBump, runShow, runSyncProgress, runValidate } from './version.ts';

// CLI の入口。コマンド名を関数に振り分けるだけで、中身は各モジュールにある。
// ファイルの分け方:
//   args.ts    フラグの解釈
//   shared.ts  読み込み・検証・表示（コマンド共通）
//   version.ts バージョンそのもの（validate / show / bump）
//   build.ts   build の操作
//   ticket.ts  ticket の操作

async function runCommand(
  command: string,
  options: ReturnType<typeof parseOptions>,
): Promise<void> {
  switch (command) {
    case 'validate':
      return runValidate(options);
    case 'sync-progress':
      return runSyncProgress(options);
    case 'show':
      return runShow(options);
    case 'bump':
      return runBump(options);
    case 'build:add':
      return runBuildAdd(options);
    case 'build:set':
      return runBuildSet(options);
    case 'build:rename':
      return runBuildRename(options);
    case 'build:remove':
      return runBuildRemove(options);
    case 'ticket:add':
      return runTicketAdd(options);
    case 'ticket:set':
      return runTicketSet(options);
    case 'ticket:remove':
      return runTicketRemove(options);
    case 'ticket:list':
      return runTicketList(options);
    default: {
      // 未知のコマンドは使い方を出して異常終了する
      console.log(USAGE);
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined) {
    console.log(USAGE);
    return;
  }
  await runCommand(command, parseOptions(rest));
}

try {
  await main();
} catch (error) {
  // 検証エラーは多行になるのでそのまま見せる
  const detail = error instanceof DocumentError ? error.message : messageOf(error);
  console.error(detail);
  process.exit(1);
}
