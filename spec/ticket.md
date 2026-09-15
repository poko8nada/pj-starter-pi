# ticket — work

A **ticket** is work, where a [build](build.md) is a thing the product has.

|            | build                         | ticket                           |
| ---------- | ----------------------------- | -------------------------------- |
| What it is | A property the product has    | The work of getting there        |
| Lifetime   | Permanent. Managed by version | Ends when done. Outside versions |
| Judged by  | The people using the product  | Whoever is building it           |

Definitions are inherited when the starter is forked; tickets are **not**. A new project starts with none, so no history from the starter carries over.

```json
{
  "id": "tkt-0001",
  "specType": "product",
  "targets": [{ "build": "auth-login", "condition": "無効な資格情報では 401 が返る" }],
  "title": "失敗系の分岐を実装",
  "verify": "空欄・形式不正・不一致の3パターンで 401 とエラー表示が出る",
  "status": "todo",
  "note": "先に認証を通す必要がある",
  "resolvedIn": 1
}
```

| Field        | Meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `id`         | `tkt-0001`. Assigned automatically; numbers are never reused               |
| `specType`   | `product` or `harness`. Tickets live in one place, so this says which      |
| `targets`    | Which build's which condition this moves forward. See below                |
| `title`      | What the work is                                                           |
| `verify`     | What done means, narrower than the condition it advances                   |
| `status`     | `todo`, `doing`, or `done`                                                 |
| `note`       | Same as a build's `note`: why it last changed                              |
| `resolvedIn` | Written by the machine. The version that was current when it became `done` |

## `targets`

`condition` names one entry of that build's `verify`, or `null` for work that touches a build without moving a condition forward (a refactor, chores). `build` and `condition` are written as pairs so that a condition cannot drift from its build.

A build can span one, many, or no tickets. One ticket may also target several builds at once — a shared component that advances a condition in three pages. `builds` is not a field because it is `targets.map(t => t.build)`.

**At most one condition per build, per ticket.** Wanting two means either splitting the ticket or splitting the build. This is what makes the work split at all: one build described as a paragraph has no seams, so every build would end up with exactly one ticket.

## Where tickets live

```
spec/tickets/
  current.json        open tickets: todo and doing
  archive/v001.json   tickets that reached done while v001 was current
```

One file each, not one per ticket. The live file holds **only open work**, so it cannot grow without bound.

Reading `progress` needs exactly two files, `current` and `archive/vN`, no matter how many versions exist. A ticket that reaches `done` moves to the archive immediately, and `resolvedIn` records which version that was — which also makes it the index for finding the ticket again when it is reopened.

Past versions' archives are **not read**. Renaming a build reaches the current archive but not an older one, and that is deliberate: the thing being checked is whether the current version agrees with the tickets. An old archive saying `page-home` where the current says `page-top` records that it was called `page-home` at the time.

## `progress`

The counts come from the tickets that point at a build:

```
progress = tickets targeting this build, in current + archive/vN
total    = how many
done     = how many have status done
```

A build with no tickets has **no `progress` field at all**. Absent means "this project is not tracking it yet". Never write `0/0`.

`progress` is stored, and `validate` checks it against the tickets for the current version. That check is what keeps the cached number honest, which is why storing it is safe at all. See [README.md](README.md) for why the two axes are kept apart.

`bump` recomputes rather than carries it over. The archive being read changes with the version, so a value that was correct for v001 would be a lie in v002. Where there are no tickets, the computation yields nothing and the field disappears.

Past versions' `progress` is a snapshot of that moment and is never checked against today's tickets.

## What validation enforces

| Enforced                                                | Only guided                         |
| ------------------------------------------------------- | ----------------------------------- |
| `targets` resolves to a real build and a real condition | whether the work belongs here       |
| at most one condition per build, per ticket             | —                                   |
| `status` in the vocabulary                              | whether the declared status is true |
| `resolvedIn` present exactly when `status` is `done`    | —                                   |
| `note` present and non-empty                            | whether the note explains anything  |
| `progress` matches the tickets (current version only)   | —                                   |
