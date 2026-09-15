import { describe, expect, it } from 'vitest';
import {
  BUILD_STATES,
  canTransition,
  formatVersion,
  isValidBuildId,
  parseSpec,
  readSpec,
  referencingBuilds,
  SPEC_TYPES,
  type BuildState,
  type Spec,
} from './schema.ts';

// spec/ の語彙・型・検証を試す単体テスト。
// 外部依存なしで回るよう、JSON の形をそのまま parseSpec に渡す。

/** 最小の build。テストごとに必要な差分だけ上書きする。 */
function buildJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gate-a',
    name: 'A',
    verify: 'A が動く',
    uses: [],
    status: { state: 'planned', text: '未着手' },
    ...overrides,
  };
}

function specJson(builds: Record<string, unknown>[]): Record<string, unknown> {
  return { name: 'P', goal: [], nongoal: [], build: builds };
}

describe('語彙', () => {
  it('specType は product と harness の2種類', () => {
    expect(SPEC_TYPES).toEqual(['product', 'harness']);
  });

  it('status は5段階の state を持つ（ライフサイクル）', () => {
    expect(BUILD_STATES).toEqual(['planned', 'building', 'working', 'retiring', 'closed']);
  });

  it('バージョンは3桁ゼロ埋め', () => {
    expect(formatVersion(1)).toBe('v001');
    expect(formatVersion(10)).toBe('v010');
    expect(formatVersion(100)).toBe('v100');
  });
});

describe('parseSpec の受理', () => {
  it('空の build 配列を許す', () => {
    const { spec, issues } = parseSpec(specJson([]), 'test');
    expect(issues).toEqual([]);
    expect(spec?.build).toEqual([]);
  });

  it('空文字でない文字列配列を許す', () => {
    const { spec } = parseSpec(
      { name: 'P', goal: ['提供する'], nongoal: ['提供しない'], build: [] },
      'test',
    );
    expect(spec?.goal).toEqual(['提供する']);
  });

  it('closed を宣言できる', () => {
    const { spec, issues } = parseSpec(
      specJson([buildJson({ status: { state: 'closed', text: 'スターター時点で実装済み' } })]),
      'test',
    );
    expect(issues).toEqual([]);
    expect(spec?.build[0]?.status.state).toBe('closed');
  });

  it('progress と status は独立している（全部 done でも state は宣言したまま）', () => {
    const { spec, issues } = parseSpec(
      specJson([
        buildJson({
          progress: { done: 3, total: 3 },
          status: { state: 'planned', text: 'チケットだけ先に起票した' },
        }),
      ]),
      'test',
    );
    expect(issues).toEqual([]);
    expect(spec?.build[0]?.status.state).toBe('planned');
    expect(spec?.build[0]?.progress).toEqual({ done: 3, total: 3 });
  });

  it('uses で他の build を参照できる', () => {
    const { spec, issues } = parseSpec(
      specJson([buildJson(), buildJson({ id: 'gate-b', uses: ['gate-a'] })]),
      'test',
    );
    expect(issues).toEqual([]);
    expect(spec?.build[1]?.uses).toEqual(['gate-a']);
  });
});

describe('遷移の規則', () => {
  const allowed: [BuildState, BuildState][] = [
    ['planned', 'building'],
    ['planned', 'working'],
    ['planned', 'retiring'],
    ['planned', 'closed'],
    ['building', 'planned'],
    ['building', 'working'],
    ['working', 'building'],
    ['working', 'retiring'],
    ['working', 'closed'],
    ['retiring', 'working'],
    ['retiring', 'closed'],
    ['closed', 'working'],
    ['closed', 'building'],
  ];
  const forbidden: [BuildState, BuildState][] = [
    ['working', 'planned'],
    ['retiring', 'planned'],
    ['closed', 'planned'],
  ];

  it.each(allowed)('許す: %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(forbidden)('拒否する: %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('retiring は宣言できる', () => {
    const { spec, issues } = parseSpec(
      specJson([buildJson({ status: { state: 'retiring', text: '呼び出し側を移行中' } })]),
      'test',
    );
    expect(issues).toEqual([]);
    expect(spec?.build[0]?.status.state).toBe('retiring');
  });
});

describe('build id の形式', () => {
  const valid = ['gate-a', 'page-home', 'api-user-create', 'hook-lefthook', 'cli-spec'];
  // 形では捕まえられないもの（定数セグメントや kind の選び方）はここに入れない。
  // `build-gate-a` は形式としては通る。それは README のガイドで導く領域。
  const invalid = [
    'Gate-A',
    'gate_a',
    'gate--a',
    '-gate-a',
    'gate-a-',
    'gate',
    'a',
    '',
    '日本語-page',
  ];

  it.each(valid)('受理する: %s', (id) => {
    expect(isValidBuildId(id)).toBe(true);
  });

  it.each(invalid)('拒否する: %s', (id) => {
    expect(isValidBuildId(id)).toBe(false);
  });

  it('セグメントが1つだと弾く（種別だけでは何を作るか決まらない）', () => {
    const { issues } = parseSpec(specJson([buildJson({ id: 'lefthook' })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.build[0].id')).toBe(true);
  });

  it('不正な id のエラーに例が含まれる', () => {
    const { issues } = parseSpec(specJson([buildJson({ id: 'badID' })]), 'test');
    const issue = issues.find((item) => item.path === 'test.build[0].id');
    expect(issue?.message).toContain('page-home');
  });

  it('定数セグメントは形式では弾けない（ガイドで導く領域）', () => {
    expect(isValidBuildId('build-gate-a')).toBe(true);
  });
});

describe('parseSpec の拒否', () => {
  it('未知のフィールドを弾く', () => {
    const { issues } = parseSpec({ ...specJson([]), extra: 1 }, 'test');
    expect(issues.some((issue) => issue.path === 'test.extra')).toBe(true);
  });

  it('build の未知のフィールドを弾く', () => {
    const { issues } = parseSpec(specJson([buildJson({ trigger: 'ui' })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.build[0].trigger')).toBe(true);
  });

  it('空文字を弾く', () => {
    const { issues } = parseSpec(specJson([buildJson({ name: '' })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.build[0].name')).toBe(true);
  });

  it('closed フィールドは廃止された（未知のフィールドとして弾く）', () => {
    const { issues } = parseSpec(specJson([buildJson({ closed: null })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.build[0].closed')).toBe(true);
  });

  it('status の語彙外の state を弾く', () => {
    const { issues } = parseSpec(
      specJson([buildJson({ status: { state: 'done', text: 'x' } })]),
      'test',
    );
    expect(issues.some((issue) => issue.path === 'test.build[0].status.state')).toBe(true);
  });

  it('status.text の欠落を弾く', () => {
    const { issues } = parseSpec(specJson([buildJson({ status: { state: 'working' } })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.build[0].status.text')).toBe(true);
  });

  it('status の未知のフィールドを弾く', () => {
    const { issues } = parseSpec(
      specJson([buildJson({ status: { state: 'working', text: 'x', reason: 'y' } })]),
      'test',
    );
    expect(issues.some((issue) => issue.path === 'test.build[0].status.reason')).toBe(true);
  });

  it('ticket 0件の progress を弾く（0/0 は書かない）', () => {
    const { issues } = parseSpec(
      specJson([buildJson({ progress: { done: 0, total: 0 } })]),
      'test',
    );
    expect(issues.some((issue) => issue.path === 'test.build[0].progress')).toBe(true);
  });

  it('done が total を超える progress を弾く', () => {
    const { issues } = parseSpec(
      specJson([buildJson({ progress: { done: 5, total: 3 } })]),
      'test',
    );
    expect(issues.some((issue) => issue.path === 'test.build[0].progress.done')).toBe(true);
  });

  it('存在しない build への uses を弾く', () => {
    const { issues } = parseSpec(specJson([buildJson({ uses: ['gate-nope'] })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.build[0].uses[0]')).toBe(true);
  });

  it('自己参照の uses を弾く', () => {
    const { issues } = parseSpec(specJson([buildJson({ uses: ['gate-a'] })]), 'test');
    expect(issues.some((issue) => issue.message.includes('自分自身'))).toBe(true);
  });

  it('id の重複を弾く', () => {
    const { issues } = parseSpec(specJson([buildJson(), buildJson()]), 'test');
    expect(issues.some((issue) => issue.message.includes('重複'))).toBe(true);
  });
});

describe('readSpec', () => {
  it('存在しないバージョンを SpecError で知らせる', async () => {
    await expect(readSpec('/nonexistent-root', 'product')).rejects.toThrow();
  });
});

describe('referencingBuilds（削除の可否判定）', () => {
  /** パースを通した Spec を作る。検証済みの形であることを保証する。 */
  function specOf(builds: Record<string, unknown>[]): Spec {
    const { spec } = parseSpec(specJson(builds), 'test');
    if (spec === undefined) {
      throw new Error('テストの前提が壊れている');
    }
    return spec;
  }

  it('参照している側の id を返す', () => {
    const spec = specOf([
      buildJson({ id: 'gate-a' }),
      buildJson({ id: 'gate-b', uses: ['gate-a'] }),
      buildJson({ id: 'gate-c', uses: ['gate-a'] }),
    ]);
    expect(referencingBuilds(spec, 'gate-a')).toEqual(['gate-b', 'gate-c']);
  });

  it('参照が無ければ空を返す（削除できる）', () => {
    const spec = specOf([buildJson({ id: 'gate-a' }), buildJson({ id: 'gate-b' })]);
    expect(referencingBuilds(spec, 'gate-b')).toEqual([]);
  });

  it('closed からも参照を数える（bump で残す判定に使う）', () => {
    const spec = specOf([
      buildJson({ id: 'gate-a' }),
      buildJson({
        id: 'gate-b',
        uses: ['gate-a'],
        status: { state: 'closed', text: '廃止' },
      }),
    ]);
    expect(referencingBuilds(spec, 'gate-a')).toEqual(['gate-b']);
  });
});
