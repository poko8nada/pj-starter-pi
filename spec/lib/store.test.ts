import { describe, expect, it } from 'vitest';
import { parseSpec, type Spec } from './spec.ts';
import { computeProgress, removalBlockers, validateSnapshot, type Snapshot } from './store.ts';
import { parseTicketFile, type Ticket } from './ticket.ts';

// progress の算出と cross-document 検証を試す。
// ファイル I/O を通さず、オブジェクトを直接組み立てて Snapshot を作る。

function buildJson(id: string, verify: string[], state = 'working'): Record<string, unknown> {
  return {
    id,
    name: id,
    verify,
    uses: [],
    status: state,
    note: 'テスト',
  };
}

function specOf(
  builds: Record<string, unknown>[],
  options: { progress?: Record<string, unknown> } = {},
): Spec {
  const withProgress = builds.map((build) => {
    const id = typeof build.id === 'string' ? build.id : undefined;
    const value = id === undefined ? undefined : options.progress?.[id];
    return value === undefined ? build : { ...build, progress: value };
  });
  const { spec, issues } = parseSpec(
    { name: 'P', goal: [], nongoal: [], build: withProgress },
    'test',
  );
  if (spec === undefined) {
    throw new Error(`テストの前提が壊れている: ${JSON.stringify(issues)}`);
  }
  return spec;
}

function ticketsOf(list: Record<string, unknown>[]): Ticket[] {
  const { file, issues } = parseTicketFile({ ticket: list }, 'test');
  if (file === undefined) {
    throw new Error(`テストの前提が壊れている: ${JSON.stringify(issues)}`);
  }
  return [...file.ticket];
}

function snapshotOf(input: {
  builds: Record<string, unknown>[];
  open?: Record<string, unknown>[];
  archived?: Record<string, unknown>[];
  progress?: Record<string, unknown>;
}): Snapshot {
  return {
    root: '/test',
    specType: 'product',
    version: 1,
    spec: specOf(input.builds, { progress: input.progress }),
    open: ticketsOf(input.open ?? []),
    archived: ticketsOf(input.archived ?? []),
  };
}

function ticket(build: string, condition: string | null, status: string, resolvedIn?: number) {
  return {
    id: `tkt-${Math.random().toString(36).slice(2, 6)}`,
    specType: 'product',
    targets: [{ build, condition }],
    title: 'T',
    verify: 'V',
    status,
    note: 'テスト',
    ...(resolvedIn === undefined ? {} : { resolvedIn }),
  };
}

describe('computeProgress', () => {
  it('チケットが0件の build はエントリを作らない（0/0 と書かない）', () => {
    const snapshot = snapshotOf({ builds: [buildJson('a-b', ['x'])] });
    expect(computeProgress(snapshot).size).toBe(0);
  });

  it('open と archive の両方を数える', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'])],
      open: [ticket('a-b', 'x', 'todo')],
      archived: [ticket('a-b', 'x', 'done', 1)],
    });
    expect(computeProgress(snapshot).get('a-b')).toEqual({ done: 1, total: 2 });
  });

  it('condition: null も分母に入る（作業であることに変わりはない）', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'])],
      open: [ticket('a-b', null, 'done', 1), ticket('a-b', 'x', 'done', 1)],
    });
    expect(computeProgress(snapshot).get('a-b')).toEqual({ done: 2, total: 2 });
  });

  it('N build : 1 ticket は両方の build を進める', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x']), buildJson('c-d', ['y'])],
      archived: [
        {
          id: 'tkt-0001',
          specType: 'product',
          targets: [
            { build: 'a-b', condition: 'x' },
            { build: 'c-d', condition: 'y' },
          ],
          title: 'T',
          verify: 'V',
          status: 'done',
          note: 'テスト',
          resolvedIn: 1,
        },
      ],
    });
    expect(computeProgress(snapshot).get('a-b')).toEqual({ done: 1, total: 1 });
    expect(computeProgress(snapshot).get('c-d')).toEqual({ done: 1, total: 1 });
  });

  it('同じ build を指す複数チケットを数える（1 build : N ticket）', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x', 'y'])],
      open: [ticket('a-b', 'x', 'doing'), ticket('a-b', 'y', 'todo')],
    });
    expect(computeProgress(snapshot).get('a-b')).toEqual({ done: 0, total: 2 });
  });
});

describe('validateSnapshot: progress の突き合わせ', () => {
  it('一致していれば通る', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'])],
      archived: [ticket('a-b', 'x', 'done', 1)],
      progress: { 'a-b': { done: 1, total: 1 } },
    });
    expect(validateSnapshot(snapshot)).toEqual([]);
  });

  it('progress が無いのにチケットがあれば弾く', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'])],
      open: [ticket('a-b', 'x', 'todo')],
    });
    expect(validateSnapshot(snapshot).some((issue) => issue.path === 'spec.a-b.progress')).toBe(
      true,
    );
  });

  it('progress があるのにチケットが無ければ弾く（手コピーの痕跡）', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'])],
      progress: { 'a-b': { done: 0, total: 1 } },
    });
    expect(validateSnapshot(snapshot).some((issue) => issue.path === 'spec.a-b.progress')).toBe(
      true,
    );
  });

  it('数が食い違えば弾く', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'])],
      open: [ticket('a-b', 'x', 'todo')],
      progress: { 'a-b': { done: 1, total: 1 } },
    });
    const issue = validateSnapshot(snapshot).find((item) => item.path === 'spec.a-b.progress');
    expect(issue?.message).toContain('期待: 0/1');
  });
});

describe('validateSnapshot: targets の参照解決', () => {
  it('存在しない build を弾く', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'])],
      open: [ticket('nope-x', 'x', 'todo')],
    });
    expect(
      validateSnapshot(snapshot).some((issue) => issue.message.includes('存在しない build')),
    ).toBe(true);
  });

  it('存在しない条件を弾く（build:set で verify を変えた取りこぼし）', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'])],
      open: [ticket('a-b', '消えた条件', 'todo')],
    });
    expect(
      validateSnapshot(snapshot).some((issue) => issue.message.includes('存在しない条件')),
    ).toBe(true);
  });

  it('condition: null は参照解決の対象外', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x'], 'planned')],
      open: [ticket('a-b', null, 'todo')],
      progress: { 'a-b': { done: 0, total: 1 } },
    });
    expect(validateSnapshot(snapshot)).toEqual([]);
  });
});

describe('validateSnapshot: working の被覆', () => {
  it('全条件が done なら通る', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x', 'y'])],
      archived: [ticket('a-b', 'x', 'done', 1), ticket('a-b', 'y', 'done', 1)],
      progress: { 'a-b': { done: 2, total: 2 } },
    });
    expect(validateSnapshot(snapshot)).toEqual([]);
  });

  it('working なのに条件が未達なら弾く', () => {
    const snapshot = snapshotOf({
      builds: [buildJson('a-b', ['x', 'y'])],
      archived: [ticket('a-b', 'x', 'done', 1)],
      open: [ticket('a-b', 'y', 'todo')],
      progress: { 'a-b': { done: 1, total: 2 } },
    });
    const issue = validateSnapshot(snapshot).find((item) => item.path === 'spec.a-b');
    expect(issue?.message).toContain('条件が done になっていません: y');
  });

  it('チケットが0件の working は検査しない（スターターの harness を壊さない）', () => {
    const snapshot = snapshotOf({ builds: [buildJson('a-b', ['x'], 'working')] });
    expect(validateSnapshot(snapshot)).toEqual([]);
  });

  it('retiring と closed は対象外（条件を満たす前に畳むのは正当）', () => {
    for (const state of ['retiring', 'closed']) {
      const snapshot = snapshotOf({
        builds: [buildJson('a-b', ['x'], state)],
        open: [ticket('a-b', 'x', 'todo')],
        progress: { 'a-b': { done: 0, total: 1 } },
      });
      expect(validateSnapshot(snapshot)).toEqual([]);
    }
  });
});

describe('removalBlockers', () => {
  it('uses の参照とチケットの参照を両方返す', () => {
    const snapshot = snapshotOf({
      builds: [
        buildJson('a-b', ['x'], 'planned'),
        { ...buildJson('c-d', ['y'], 'planned'), uses: ['a-b'] },
      ],
      open: [ticket('a-b', 'x', 'todo')],
    });
    const blockers = removalBlockers(snapshot, 'a-b');
    expect(blockers).toContain('build c-d');
    expect(blockers.some((entry) => entry.startsWith('ticket tkt-'))).toBe(true);
  });

  it('参照が無ければ空（削除できる）', () => {
    const snapshot = snapshotOf({ builds: [buildJson('a-b', ['x'], 'planned')] });
    expect(removalBlockers(snapshot, 'a-b')).toEqual([]);
  });
});
