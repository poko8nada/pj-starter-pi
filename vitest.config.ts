// 詳細が必要なときだけ TEST_VERBOSE=1（日本語補足：要約なしdefaultがvitest 4のbasic代替）。
import { defineConfig } from 'vitest/config';

const verbose = process.env.TEST_VERBOSE === '1';

export default defineConfig({
  test: {
    reporters: verbose ? ['verbose'] : [['default', { summary: false }]],
  },
});
