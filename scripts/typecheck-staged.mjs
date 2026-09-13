// 触ったファイルのみを型チェックするスクリプト（tsc-files の pnpm 非互換を解消する代替）
// 使い方: node scripts/typecheck-staged.mjs <file1> <file2> ...
// 仕組み: extends を使う一時 tsconfig を生成し、対象ファイルだけを tsc -p で検査する
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---- 設定 ----
// 型チェックの対象拡張子（.js 系は allowJs で構文まで検査する）
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// 専用 tsconfig を持つハーネスディレクトリ
const HARNESS_DIRS = ['.pi', '.opencode'];

const checkableExt = new Set(CODE_EXTENSIONS);

const root = process.cwd();
const bin = (name) => path.join(root, 'node_modules', '.bin', name);

// 引数から対象ファイルを抽出（存在する ts/tsx のみ）
const files = process.argv.slice(2).filter((f) => {
  const abs = path.isAbsolute(f) ? f : path.join(root, f);
  return fs.existsSync(abs) && checkableExt.has(path.extname(abs));
});

if (files.length === 0) process.exit(0);

// tsconfig ごとにファイルをグループ化する
const groups = new Map();
for (const f of files) {
  const abs = path.isAbsolute(f) ? f : path.join(root, f);
  const rel = path.relative(root, abs);
  // 専用 tsconfig を持つハーネスディレクトリはその tsconfig を使う
  const harnessDir = HARNESS_DIRS.find((d) => rel.startsWith(`${d}${path.sep}`));
  const tsconfig = harnessDir
    ? path.join(root, harnessDir, 'tsconfig.json')
    : path.join(root, 'tsconfig.json');
  if (!fs.existsSync(tsconfig)) continue;

  groups.set(tsconfig, [...(groups.get(tsconfig) ?? []), abs]);
}

// グループごとに型チェックを実行する
// ループ内に try/finally を置くと oxlint の no-unreachable-loop が誤検知するため関数に切り出す
const runTypecheckGroup = (tsconfig, groupFiles) => {
  // 一時 tsconfig を extends 元と同じディレクトリに置く
  // （types や relative パスの解決が tsconfig の位置基準になるため）
  const configDir = path.dirname(tsconfig);
  const tmp = path.join(
    configDir,
    `.typecheck-staged-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const config = JSON.stringify(
    {
      extends: './tsconfig.json',
      files: groupFiles.map((f) => path.relative(configDir, f)),
      include: [],
    },
    null,
    2,
  );
  fs.writeFileSync(tmp, config);
  try {
    const result = spawnSync(bin('tsc'), ['-p', tmp, '--noEmit'], { stdio: 'inherit' });
    if (result.error) {
      console.error(`[typecheck-staged] Failed to run tsc: ${result.error.message}`);
      return true;
    }
    return result.status !== 0;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
};

let failed = false;
for (const [tsconfig, groupFiles] of groups) {
  if (runTypecheckGroup(tsconfig, groupFiles)) failed = true;
}

process.exit(failed ? 1 : 0);
