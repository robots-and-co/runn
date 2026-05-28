---
name: runn-new-project
description:
  "Create a new project in this Runn instance (top-level card), attach it to an
  existing client, populate its notes, and seed it with an ordered task list —
  all in one go via the local HTTP API on 127.0.0.1:17777. Use when the user
  says things like 'spin up a new project for <client>', 'add a project called
  X with these tasks', 'create a runn project for <client> with notes …', or
  any request that combines project + client + tasks in this codebase. Only
  runs against this repo's own backend; no remote calls."
version: 0.1.0
---

# Runn — new project (with client + notes + ordered tasks)

## Domain in one paragraph

In Runn, **a project is just a top-level card** (`parent_id: null`). Its title
is the project name; its `notes_md` is the project's notes; its `client_id`
binds it to a billing/workspace client. **Tasks are child cards** of that
project (`parent_id` = the project's `id`). Order on the board is determined
by ascending `sort_order` (a number). There is no `/projects` endpoint —
everything goes through `POST /cards`. See `HANDOFF.md` "Billing model" for
the full schema rationale.

## API base

```
http://127.0.0.1:17777
```

Sanity check before doing anything else — if this fails, nothing else will:

```bash
curl -sf http://127.0.0.1:17777/ -o /dev/null && echo OK || echo "runn down — check 'docker ps' for the 'runn' container on :17777"
```

## Recipe

### 1. Find the client_id

If the user named a client ("for ZIS", "for LTHCS", "for waz"), resolve the
**name → id** by listing clients. Names are user-facing; ids are stable.

```bash
curl -sf http://127.0.0.1:17777/clients | python3 -c "
import json, sys
for c in json.load(sys.stdin):
    print(f'{c[\"id\"]:<28} {c[\"name\"]:<20} workspace={c.get(\"workspace\",\"\")}  non_billable={c.get(\"non_billable\",False)}')
"
```

Ids look like `cl_efem`, `cl_waz`, `cl_mpewz8hv_3680`, or `zimmermann-industries`
(legacy slug). Match on `name` case-insensitively; if there's no match, ask the
user before guessing — do **not** silently create a client just to attach the
project. Client creation is a separate concern (rate, GST, workspace,
non_billable flag, etc.) and should be deliberate.

### 2. Create the project card

A project is just a card with `parent_id: null`. Required-ish fields:
`title`, `client_id`, `notes_md`. Everything else has a server default.

```bash
PROJECT_ID=$(curl -sf -X POST http://127.0.0.1:17777/cards \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "<project name>",
    "parent_id": null,
    "client_id": "<cl_… from step 1>",
    "notes_md": "<markdown project notes>",
    "status": "queued",
    "tags": []
  }' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

echo "Created project $PROJECT_ID"
```

Notes are markdown — newlines and `#` headings are fine; pass them as a JSON
string (escape `"` and `\n` properly — building the body with `python3 -c`
or `jq -n` is safer than inline `-d` for multi-line notes).

### 3. Seed tasks in order

Each task is another `POST /cards`, with `parent_id` set to the project id and
a `sort_order` that increases monotonically. The board renders ascending,
so the first task should have the **smallest** number.

A simple, collision-resistant pattern: base on `Date.now()` (the server's
default), then add `i * 1000` per task. The 1000ms gap leaves room for later
drag-and-drop reordering between items without renumbering everything.

```bash
BASE=$(date +%s%3N)        # ms since epoch
TASKS=(
  "Task one|notes for task one"
  "Task two|notes for task two"
  "Task three|"
)

i=0
for entry in "${TASKS[@]}"; do
  title="${entry%%|*}"
  notes="${entry#*|}"
  sort_order=$((BASE + i * 1000))
  curl -sf -X POST http://127.0.0.1:17777/cards \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,sys; print(json.dumps({
      'title': sys.argv[1],
      'parent_id': sys.argv[2],
      'notes_md': sys.argv[3],
      'sort_order': int(sys.argv[4]),
      'status': 'queued',
      'assignee': None
    }))" "$title" "$PROJECT_ID" "$notes" "$sort_order")" >/dev/null
  i=$((i + 1))
done
```

`assignee: null` deliberately leaves the AI/human picker on the task header
(the user clicks AI or Human when they open it). Set `"assignee": "ai"` if
the task should auto-run when the project's queue walker reaches it; set
`"assignee": "human"` for a manual task.

### 4. Verify

```bash
curl -sf "http://127.0.0.1:17777/cards/$PROJECT_ID" | python3 -m json.tool
# Then list tasks under it (no dedicated endpoint — filter the full /cards list):
curl -sf http://127.0.0.1:17777/cards | python3 -c "
import json, sys, os
pid = os.environ['PROJECT_ID']
kids = [c for c in json.load(sys.stdin) if c.get('parent_id') == pid]
kids.sort(key=lambda c: c.get('sort_order', 0))
for c in kids:
    print(f\"  {c.get('sort_order',0):>16}  {c['status']:<8}  {c['title']}\")
" PROJECT_ID="$PROJECT_ID"
```

## Field reference (cards POST body)

| field          | type            | notes                                                                 |
|----------------|-----------------|-----------------------------------------------------------------------|
| `title`        | string          | Project name or task title.                                           |
| `parent_id`    | string \| null  | `null` = project (top-level). String = task under that project.       |
| `client_id`    | string \| null  | Only meaningful on the project; tasks inherit via `resolveProjectId`. |
| `notes_md`     | string          | Markdown. Use `\n` for newlines in JSON.                              |
| `sort_order`   | number          | Ascending = earlier on the board. Defaults to `Date.now()`.           |
| `status`       | string          | `queued` (default) \| `doing` \| `review` \| `done` \| `blocked` \| `hold`. |
| `assignee`     | "ai" \| "human" \| null | Leave `null` to show the picker on first open.                |
| `tags`         | string[]        | Free-form labels.                                                     |
| `hours`        | number \| null  | Billable hours estimate / actuals.                                    |
| `blocking`     | boolean         | If `true`, queue halts on this task until it's `done`.                |
| `non_billable` | boolean \| null | Project-level override of the client's `non_billable` flag.           |

## Gotchas

- **The server must be up.** `frontend/` is live-mounted but the API lives in
  `worker/server.js`; if `docker ps` doesn't show `runn` on `:17777`, the
  POSTs will silently fail. Always do the curl health-check first.
- **No `/projects` route exists.** The billing-project layer was retired
  (HANDOFF.md). A "project" = a top-level card. Don't go looking for
  `POST /projects` — it doesn't exist.
- **No `location.cwd`.** Workspace/cwd is derived from
  `client.workspace` at spawn time. Don't try to set a cwd on the card.
- **Don't create a client just to attach the project.** If the named client
  isn't found, ask the user. Creating a client has billing implications
  (rate, GST, workspace dir on disk, non_billable flag) that need explicit
  decisions.
- **`sort_order` is a float-friendly number, not an integer.** The frontend's
  drag-to-reorder picks midpoints between neighbours, so future inserts
  between two of your tasks work fine without renumbering.
- **Status `queued` + `assignee: ai` on a task whose project has the runn
  switch on will start spawning immediately.** If the project should sit
  idle until the user reviews it, leave `assignee: null` (the default of this
  recipe) or use status `hold`.
- **Multi-line `notes_md` via curl `-d`:** Easiest reliable form is to build
  the JSON in Python (`python3 -c "import json,sys; print(json.dumps({...}))"`)
  and pipe it in, rather than embedding raw newlines in a shell heredoc.

## When NOT to use this skill

- Creating a **client** (use `POST /clients` directly; needs rate/workspace
  decisions).
- Editing existing project notes or task lists — that's a plain
  `PATCH /cards/:id`, no skill needed.
- Anything outside this repo's local Runn instance.
