import { extname } from 'node:path';

/** oxfmt が扱える拡張子（整形対象） */
const FORMATTABLE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.yaml',
  '.yml',
  '.css',
  '.html',
]);

/** oxlint --deny-warnings が扱える拡張子 */
const LINTABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs']);

/**
 * 対象拡張子で絞り込む。
 * 非対応の拡張子を渡すと oxfmt/oxlint が「No files found」で異常終了するため、
 * 実行前に対象を確定させておく必要がある。
 */
export function filterByExtensions(paths: readonly string[], kind: 'format' | 'lint'): string[] {
  const allowed = kind === 'format' ? FORMATTABLE_EXTENSIONS : LINTABLE_EXTENSIONS;
  return paths.filter((path) => allowed.has(extname(path).toLowerCase()));
}
