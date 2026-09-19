# marketplace-dev-public-resource

Backend svc 1 of 9. Public tier, resource concern. Port 4027.

**Read parent first** — [`../../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)
Tier/concern split, port table, terminology, auth model live there. Not here.

| Need | File |
|---|---|
| what this svc is, its GraphQL surface, its traps | [`README.md`](./README.md) |
| hook internals, gate order, node selection, mutation-gate rationale | [`REPO.md`](./REPO.md) |
| GitNexus rules, this repo's registry name | [`AGENTS.md`](./AGENTS.md) |
| anything cross-repo | parent `CLAUDE.md` |

## ⚠️ NEVER run the mutation gate by hand

`yarn test:mutation` is **hook-only** — it runs when `pre-push` calls it and at no other time: not to
check a change, not before a commit, not on one file, not to confirm a survivor is fixed, and never via
`stryker` directly. Why, and how to answer a survivor: [`REPO.md`](./REPO.md).

## Rules

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`. Merge = user decision alone.
- Merged → delete branch: `git branch -d <slug>`. `-d` only. `-D` never.
- **No remote.** Push-on-request: no `git push` unless the user asked for it in that message.
- **Never lower a coverage or mutation threshold, and never remove a gate.** Threshold miss → write the
  missing test. Bypasses (`SKIP_QODANA=1`, `--no-verify`) are gate removals: use only when the user says so.
- Tabs, not spaces. eslint + prettier both enforce.
- English only — identifiers, comments, fixtures. No exception.
- Domain query/mutation → **resource** svc. Token lifecycle → **authorization** svc.

## GitNexus

Run `impact({target, repo})` before editing a symbol. Run `detect_changes()` before committing —
`repo:` is mandatory and must always be a `marketplace*` registry name. Full rules, resources, CLI skill
map: [`AGENTS.md`](./AGENTS.md).
