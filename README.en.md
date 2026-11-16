# dsh-content-cleaner · session & cache cleaner

A native plugin for the **dsh-go phone app**: list sessions, delete them, clear caches. Everything happens on local disk; nothing touches the network.

> Built for the **dsh-go native (Flutter) UI**. It is not a Harness web plugin: no `client.js`, no HTTP route, no `platform` field.

## 1. What it is

After install, the app gains one entry, "Session & cache cleaner", holding a single panel with three parts:

| Part | Content |
|---|---|
| **Overview** | Total sessions, total size, how many are deletable, project folders — all scanned live |
| **Sessions** | One row per session: title · relative time · size; tap a deletable row to pick it; running and current sessions are greyed out |
| **Caches** | Two cache folders, each with size and file count, each clearable with one tap |

## 2. Relationship with `dsh-session-cleaner`

The old plugin only works in the **web** UI: it registers a `POST /api-ext/session.delete` route and injects a menu node into the page DOM. The phone app is a Flutter native UI: it never calls that route and has no such DOM, so the old plugin does nothing on the phone.

This plugin is the **native phone version**:

- it keeps the deletion order the old plugin proved out (refuse running → stop idle agent → detach from the live store → remove files) but triggers it from a panel tap instead of HTTP;
- it adds the cleanup the old plugin missed: deleting a session also removes its projection cache under `storages/session_projcache` and strips it from the workspace record, so no "ghost row" stays behind;
- the two are **independent and can be installed together**: keep `dsh-session-cleaner` for the web UI, use this one on the phone.

## 3. Install

```sh
dsh plugin --profile web add /path/to/dsh-content-cleaner
```

The install is a link to that directory, so **do not delete the directory**.

> **Important**: changes to `package.json` are picked up automatically; changes inside `lib/` **require** restarting the engine from the app's Engine page.

## 4. Where to find it

- "All features" list → "Session & cache cleaner"
- Chat details page → "Plugins" tab → "Session & cache cleaner"

## 5. What is deleted / what is never touched

**Deleted** (always after your explicit confirmation):

| Target | Note |
|---|---|
| `sessions/<project>/<session id>/` | the whole session directory of a picked session |
| `storages/session_projcache/sessions/<session id>.json` | that session's title and projection cache, so the list has no ghost row |
| that session's entry in `storages/workspace.json` | removed from workspace, archived and pinned lists (`workspace.json.bak` is written first) |
| contents of `cache/` | bridge and temp files; the folder stays and rebuilds itself |
| contents of `storages/session_projcache/sessions/` | titles may show `(untitled)` until sessions are reopened or the engine restarts |

**Never touched**:

- `storages/cost-meter/` — cost ledger, clearing it resets billing stats;
- `speech-to-text/` — speech model, it would have to be downloaded again;
- `sessions/.dsh-go-lifecycle/` — engine-owned locks and tombstones;
- **running sessions** (an agent is busy);
- **the chat you are in right now**.

Both an allow-list and a deny-list are enforced in code: only those two cache folders are clearable, and any target path containing `cost-meter` or `speech-to-text` is refused outright.

## 6. Risk warning

- **Deletion is irreversible**: no trash, no undo, no backup. The confirm row states "About to delete N session(s), X MB" — read it before tapping.
- **Bulk delete**: "Select all" can wipe every deletable session in one go, with a single confirmation.
- Deleting a session does not affect other sessions, your models, keys, settings or workspace files themselves.
- After clearing the projection cache, session titles briefly read `(untitled)`; that is expected.

## 7. Uninstall

```sh
dsh plugin --profile web remove dsh-content-cleaner
```

Then delete the repository directory. Uninstalling removes no session or cache data.

## 8. Self-checks

```sh
node scripts/selftest.mjs        # runs the full flow in a temp home; prints "全部通过" at the end
node scripts/privacy-scan.mjs    # pre-open-source privacy scan; block hits must be 0
node scripts/make-test-session.mjs 'test session'   # creates a safely deletable test session
```

## 9. License and authorship

MIT. Authored as `dsh-content-cleaner contributors`.
