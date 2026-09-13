# sound-notify

Plays a system sound and sends a cmux notification when pi needs your attention.

## Install (global)

```bash
mkdir -p ~/.pi/agent/extensions/sound-notify
cp .pi/extensions/sound-notify/index.ts ~/.pi/agent/extensions/sound-notify/
```

## Notifications

| Trigger           | pi hook                                         | Sound | cmux subtitle |
| ----------------- | ----------------------------------------------- | ----- | ------------- |
| Permission prompt | `ui_prompt_start` (title matches /permission/i) | Blow  | Permission    |
| Any other dialog  | `ui_prompt_start`                               | Ping  | Question      |
| Turn complete     | `agent_settled`                                 | Glass | Done          |

- `agent_settled` fires once per turn, after retries, auto-compaction, and queued
  follow-ups have all finished. It does not fire per `agent_end`.
- `ui_prompt_start` fires around `ctx.ui.select/confirm/input/editor/custom`.
  Nested prompts are coalesced; sequential dialogs fire separately.
- Sounds are skipped when `ctx.hasUI` is false (print / JSON mode) to avoid
  noise in CI and piped runs.

## Configuration

Optional. Copy `config.example.json` to `config.json` in the same directory:

```json
{
  "enabled": true,
  "notifications": true,
  "sounds": { "permission": "Blow", "question": "Ping", "done": "Glass" }
}
```

Sound names resolve to `/System/Library/Sounds/<name>.aiff`.
A missing or invalid `config.json` falls back to the defaults above.
