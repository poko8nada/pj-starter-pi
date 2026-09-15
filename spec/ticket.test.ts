import { describe, expect, it } from 'vitest';
import { formatTicketId, isValidTicketId, parseTicketFile, type Ticket } from './ticket.ts';

// チケットの形の検証を試す。単体で回るよう、JSON の形をそのまま parseTicketFile に渡す。

/** 最小の ticket。テストごとに必要な差分だけ上書きする。 */
function ticketJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tkt-0001',
    specType: 'product',
    targets: [{ build: 'auth-login', condition: 'セッションが発行される' }],
    title: 'ログインを実装',
    verify: '正しい資格情報でセッションが得られる',
    status: 'todo',
    ...overrides,
  };
}

function fileJson(tickets: Record<string, unknown>[]): Record<string, unknown> {
  return { ticket: tickets };
}

/** 検証を通った Ticket を取り出す。前提が壊れていたらテストを失敗させる。 */
function parsed(tickets: Record<string, unknown>[]): Ticket[] {
  const { file, issues } = parseTicketFile(fileJson(tickets), 'test');
  expect(issues).toEqual([]);
  if (file === undefined) {
    throw new Error('検証に通るはずの入力が通らなかった');
  }
  return [...file.ticket];
}

describe('ticket の id', () => {
  it('build と同じ基準（2セグメント以上）を使う', () => {
    expect(isValidTicketId('tkt-0001')).toBe(true);
    expect(isValidTicketId('0001')).toBe(false);
    expect(isValidTicketId('tkt')).toBe(false);
    expect(isValidTicketId('Tkt-0001')).toBe(false);
  });

  it('4桁ゼロ埋めで採番する', () => {
    expect(formatTicketId(1)).toBe('tkt-0001');
    expect(formatTicketId(42)).toBe('tkt-0042');
    expect(formatTicketId(12345)).toBe('tkt-12345');
  });

  it('不正な id を弾く', () => {
    const { issues } = parseTicketFile(fileJson([ticketJson({ id: 'nope' })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.ticket[0].id')).toBe(true);
  });

  it('id の重複を弾く', () => {
    const { issues } = parseTicketFile(
      fileJson([ticketJson(), ticketJson({ title: '別の作業' })]),
      'test',
    );
    expect(issues.some((issue) => issue.message.includes('重複'))).toBe(true);
  });
});

describe('targets', () => {
  it('複数の build を指せる（N build : 1 ticket）', () => {
    const tickets = parsed([
      ticketJson({
        targets: [
          { build: 'component-button', condition: '押すと発火する' },
          { build: 'page-home', condition: 'ボタンが表示される' },
        ],
      }),
    ]);
    expect(tickets[0]?.targets).toHaveLength(2);
  });

  it('condition に null を書ける（触るが条件は進めない）', () => {
    const tickets = parsed([ticketJson({ targets: [{ build: 'auth-login', condition: null }] })]);
    expect(tickets[0]?.targets[0]?.condition).toBeNull();
  });

  it('condition の省略を弾く（書き忘れと区別できない）', () => {
    const { issues } = parseTicketFile(
      fileJson([ticketJson({ targets: [{ build: 'auth-login' }] })]),
      'test',
    );
    expect(issues.some((issue) => issue.path === 'test.ticket[0].targets[0].condition')).toBe(true);
  });

  it('空の targets を弾く（親の無い作業は存在しない）', () => {
    const { issues } = parseTicketFile(fileJson([ticketJson({ targets: [] })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.ticket[0].targets')).toBe(true);
  });

  it('同じ build の重複を弾く（1 ticket = 1 build につき条件1つ）', () => {
    const { issues } = parseTicketFile(
      fileJson([
        ticketJson({
          targets: [
            { build: 'auth-login', condition: 'A' },
            { build: 'auth-login', condition: 'B' },
          ],
        }),
      ]),
      'test',
    );
    expect(issues.some((issue) => issue.message.includes('同じ build を2回指定できません'))).toBe(
      true,
    );
  });

  it('targets の未知のフィールドを弾く', () => {
    const { issues } = parseTicketFile(
      fileJson([ticketJson({ targets: [{ build: 'auth-login', condition: 'x', extra: 1 }] })]),
      'test',
    );
    expect(issues.some((issue) => issue.path === 'test.ticket[0].targets[0].extra')).toBe(true);
  });
});

describe('status と resolvedIn', () => {
  it('todo / doing は resolvedIn を持たない', () => {
    expect(parsed([ticketJson({ status: 'todo' })])[0]?.resolvedIn).toBeUndefined();
    expect(parsed([ticketJson({ status: 'doing' })])[0]?.resolvedIn).toBeUndefined();
  });

  it('done は resolvedIn を持つ', () => {
    const tickets = parsed([ticketJson({ status: 'done', resolvedIn: 1 })]);
    expect(tickets[0]?.resolvedIn).toBe(1);
  });

  it('done なのに resolvedIn が無いものを弾く', () => {
    const { issues } = parseTicketFile(fileJson([ticketJson({ status: 'done' })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.ticket[0].resolvedIn')).toBe(true);
  });

  it('done でないのに resolvedIn があるものを弾く（戻し忘れの検出）', () => {
    const { issues } = parseTicketFile(
      fileJson([ticketJson({ status: 'doing', resolvedIn: 1 })]),
      'test',
    );
    expect(issues.some((issue) => issue.path === 'test.ticket[0].resolvedIn')).toBe(true);
  });

  it('語彙外の status を弾く', () => {
    const { issues } = parseTicketFile(fileJson([ticketJson({ status: 'blocked' })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.ticket[0].status')).toBe(true);
  });
});

describe('TicketFile', () => {
  it('空の ticket 配列を許す', () => {
    const { file, issues } = parseTicketFile({ ticket: [] }, 'test');
    expect(issues).toEqual([]);
    expect(file?.ticket).toEqual([]);
  });

  it('ticket フィールドの欠落を弾く', () => {
    const { issues } = parseTicketFile({}, 'test');
    expect(issues.some((issue) => issue.path === 'test.ticket')).toBe(true);
  });

  it('未知のフィールドを弾く', () => {
    const { issues } = parseTicketFile({ ticket: [], extra: 1 }, 'test');
    expect(issues.some((issue) => issue.path === 'test.extra')).toBe(true);
  });

  it('specType を検証する', () => {
    const { issues } = parseTicketFile(fileJson([ticketJson({ specType: 'other' })]), 'test');
    expect(issues.some((issue) => issue.path === 'test.ticket[0].specType')).toBe(true);
  });

  it('空文字を弾き、前後の空白は落とす', () => {
    expect(
      parseTicketFile(fileJson([ticketJson({ title: '   ' })]), 'test').issues.length,
    ).toBeGreaterThan(0);
    expect(parsed([ticketJson({ title: '  ログイン  ' })])[0]?.title).toBe('ログイン');
  });
});
