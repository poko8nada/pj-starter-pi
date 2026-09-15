import {
  asStringList,
  fail,
  has,
  requireSingleValue,
  requireValue,
  single,
  type Options,
} from './args.ts';
import { loadSnapshot, persist, throwIfIssues, type Snapshot } from '../lib/store.ts';
import {
  formatTicketId,
  nextTicketNumber,
  ticketsFile,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
  type TicketTarget,
} from '../lib/ticket.ts';

// ticket のコマンド。build のコマンド（cli.ts）とは別の文書を扱うので分ける。
// チケットはバージョンに属さないが、done の行き先（archive/vN）が要るので現行版を読む。

/** 現行版とチケットを読み、検証してから使う。 */
async function withSnapshot(
  options: Options,
  use: (snapshot: Snapshot) => void,
): Promise<Snapshot> {
  const snapshot = await loadSnapshot(options.root, options.specType);
  throwIfIssues(snapshot);
  use(snapshot);
  return snapshot;
}

function findTicket(snapshot: Snapshot, id: string): Ticket {
  const found = [...snapshot.open, ...snapshot.archived].find((ticket) => ticket.id === id);
  if (found === undefined) {
    fail(`ticket が見つかりません: ${id}`);
  }
  return found;
}

function readTicketStatus(raw: string | undefined): TicketStatus {
  const matched = TICKET_STATUSES.find((status) => status === raw);
  if (matched === undefined) {
    fail(`--status は次のいずれかです: ${TICKET_STATUSES.join(', ')}（受け取った値: ${raw}）`);
  }
  return matched;
}

/**
 * --build / --condition の組を読み取る。両方を繰り返して、複数の build を指せる。
 * condition は文字列か、リテラル "null"（触るが条件は進めない）。
 */
function readTargets(options: Options): TicketTarget[] {
  const buildList = asStringList(options.values.build);
  const conditionList = asStringList(options.values.condition);

  if (buildList.length === 0) {
    fail('--build を1つ以上指定してください');
  }
  if (buildList.length !== conditionList.length) {
    fail(
      `--build と --condition は同じ数だけ指定してください（build: ${buildList.length}、condition: ${conditionList.length}）`,
    );
  }

  return buildList.map((build, index) => {
    const id = build.trim();
    if (id === '') {
      fail(`--build が空です（${index + 1}番目）`);
    }
    const raw = (conditionList[index] ?? '').trim();
    if (raw === '') {
      fail(`--condition を指定してください（${id}）。進めない場合は null と書きます`);
    }
    return { build: id, condition: raw === 'null' ? null : raw };
  });
}

/**
 * --condition だけの更新。対象が1つのときだけ許す。
 * 複数の build を持つ ticket では、どの build の条件か決まらないため。
 */
function retarget(options: Options, current: Ticket): TicketTarget[] {
  const [first] = current.targets;
  if (current.targets.length !== 1 || first === undefined) {
    fail(
      `--condition を変えられるのは build が1つの ticket だけです（${current.id} は ${current.targets.length} 個）`,
    );
  }
  const raw = requireValue(options, 'condition', '--condition');
  return [{ build: first.build, condition: raw === 'null' ? null : raw }];
}

export async function runTicketAdd(options: Options): Promise<void> {
  const snapshot = await withSnapshot(options, () => undefined);
  const targets = readTargets(options);
  const id = formatTicketId(nextTicketNumber([...snapshot.open, ...snapshot.archived]));

  // 新規 ticket は todo から始まる。resolvedIn は done になったときに機械が書く。
  const ticket: Ticket = {
    id,
    specType: options.specType,
    targets,
    title: requireValue(options, 'title', '--title'),
    verify: requireSingleValue(options, 'verify', '--verify'),
    status: 'todo',
    note: requireValue(options, 'note', '--note'),
  };

  await persist(snapshot, [...snapshot.open, ...snapshot.archived, ticket], snapshot.spec);
  console.log(`added ${id} -> ${ticketsFile(options.root)}`);
}

export async function runTicketSet(options: Options): Promise<void> {
  const snapshot = await withSnapshot(options, () => undefined);
  const id = requireValue(options, 'id', '--id');
  const current = findTicket(snapshot, id);

  const touched =
    has(options, 'title') ||
    has(options, 'verify') ||
    has(options, 'status') ||
    has(options, 'condition') ||
    has(options, 'note');
  if (!touched) {
    fail(
      'ticket:set には少なくとも1つ変更するフラグが必要です（--title / --verify / --status / --condition / --note）',
    );
  }

  const status = has(options, 'status')
    ? readTicketStatus(single(options, 'status'))
    : current.status;

  const updated: Ticket = {
    id: current.id,
    specType: current.specType,
    targets: has(options, 'condition') ? retarget(options, current) : current.targets,
    title: has(options, 'title') ? requireValue(options, 'title', '--title') : current.title,
    verify: has(options, 'verify')
      ? requireSingleValue(options, 'verify', '--verify')
      : current.verify,
    status,
    note: requireValue(options, 'note', '--note'),
    // resolvedIn は done のときだけ持つ。機械が書く値なので、状態遷移に合わせてここで面倒を見る。
    ...(status === 'done' ? { resolvedIn: snapshot.version } : {}),
  };

  const tickets = [...snapshot.open, ...snapshot.archived].map((ticket) =>
    ticket.id === id ? updated : ticket,
  );
  await persist(snapshot, tickets, snapshot.spec);
  console.log(`updated ${id} -> ${status}`);
}

export async function runTicketRemove(options: Options): Promise<void> {
  const snapshot = await withSnapshot(options, () => undefined);
  const id = requireValue(options, 'id', '--id');
  findTicket(snapshot, id);
  const tickets = [...snapshot.open, ...snapshot.archived].filter((ticket) => ticket.id !== id);
  await persist(snapshot, tickets, snapshot.spec);
  console.log(`removed ${id}`);
}

/** 一覧を出す。既定は open のみ。--all で archive も含める。 */
export async function runTicketList(options: Options): Promise<void> {
  const snapshot = await loadSnapshot(options.root, options.specType);
  const open = snapshot.open.map((ticket) => ({ ticket, archived: false }));
  const archived = snapshot.archived.map((ticket) => ({ ticket, archived: true }));
  const rows = has(options, 'all') ? [...open, ...archived] : open;

  if (rows.length === 0) {
    console.log('ticket はありません');
    return;
  }
  for (const row of rows) {
    const { ticket } = row;
    const where = ticket.targets
      .map((target) =>
        target.condition === null ? target.build : `${target.build}#${target.condition}`,
      )
      .join(', ');
    const suffix = row.archived ? ` (v${String(ticket.resolvedIn).padStart(3, '0')})` : '';
    console.log(`  ${ticket.status.padEnd(6)} ${ticket.id}  ${ticket.title}${suffix}`);
    console.log(`         ${where}`);
  }
}
