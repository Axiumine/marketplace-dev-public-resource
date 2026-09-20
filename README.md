# marketplace-dev-public-resource

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Axiumine/marketplace-dev-public-resource/badge)](https://scorecard.dev/viewer/?uri=github.com/Axiumine/marketplace-dev-public-resource)

> [!WARNING]
> **Work in progress — this software is not tested yet.** It has never run outside a developer
> workstation: no real deployment, no load test, no security review, no upgrade path. Parts of the
> platform are deliberately unbuilt, and anything here — schemas, endpoints, configuration, file
> layout — can still change without notice. Whatever automated gates this repo runs, treat the result
> as unproven: do not point it at real users or real data.
> Read [`docs/PRODUCTION_HARDENING.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/docs/PRODUCTION_HARDENING.md) before taking any of it further.

Domain GraphQL for the **public** tier — everything an anonymous visitor can read, plus the four
account-creation mutations that must be reachable before anyone has a session. Port **4027**, endpoint
`/public-resource`.

Token lifecycle for this tier is not here: `marketplace-dev-public-authorization` (4028) mints the
sessions, and this service only serves what needs no session at all.

## What it answers

| Queries | |
|---|---|
| `companies`, `companiesNearby`, `companyBySlug` | the shop directory — a shop *is* a `company`, so there is no shop query |
| `items`, `itemBySlug`, `itemCategories` | the domain-neutral catalogue (ADR-008) |
| `searchCompanies`, `searchItems` | text search, one indexed collection per field — the caller picks which, and gets one page of it |
| `sitemapEntries` | what the SSR frontend builds `sitemap.xml` from |
| `publicHelloNoArgs`, `publicHelloArgs` | liveness probes, kept deliberately |

| Mutations | |
|---|---|
| `resetPwd`, `updatePwd` | the seller reset flow's two halves |
| `shopOwnerRegister` | seller self-service registration — parked on `waitApprov` until an admin clears it |
| `userRegister` | end-customer self-service registration — no approval step, unlike `ShopOwner` |
| `userVerifyEmailResend` | re-sends the confirmation mail |
| `userResetPwd`, `userUpdatePwd` | the customer reset flow's two halves |
| `publicMutNoArgs`, `publicMutArgs` | liveness probes |

⚠️ **A completed reset ends every session the account holds**. `updatePwd` and `userUpdatePwd` both
call `revokeAllSessionsForAccount` once the write has committed, so somebody resetting their password
because they believe another person is inside the account actually closes that person out. The address is
looked up here, by `login.email`, because koa-utils' delegate answers a bare boolean and never names the
account it wrote to. A revoke that fails answers 500: the password is live, the hash is spent, and the
caller has to request a fresh link — accepted, because the alternative is reporting success while a stolen
session stays open.

⚠️ **`userRegister` has four outcomes and answers `true` for every one of them.** A 409 on a taken
address would make it an account-enumeration oracle, so the outcomes are told apart only in the inbox: a
new registration, a restarted attempt and a *reopened* one all get an activation link, while an address
that already has a **live** verified account gets the "you are already registered" mail.

⚠️ **The fourth outcome is the one to know about: a closed account is hard-deleted here.** A document
`userDel` stamped is still verified, so before this existed the mutation answered "already registered"
for thirty days about an account nobody could log into. It is now destroyed and the address registered
from scratch — the platform's **one application hard delete** (ADR-011 §Amendment 2026-08-26). Nothing
is being invented: `user.deleted_ttl` already removes that document thirty days after the stamp, and
this brings the removal forward to the request that needs the address, which makes the erasure earlier
than the retention rule requires rather than later. The new account is new in every sense — new `_id`,
no personal data, no addresses, unverified until the link is opened.

## The one service with HTTP routes of its own

Every other service is GraphQL and nothing else. This one also mounts three `@koa/router` routes, because
an email confirmation link is a URL a mail client opens, not a GraphQL document:

```
GET /
GET /verify-email/:email/:hash            → ShopOwner
GET /verify-email-user/:email/:hash       → User
```

Two paths rather than one because tier is *which collection you authenticate against* (ADR-002) — the hash
is looked up in a different collection each time, and a single route would have to be told which, by a
caller that could lie.

⚠️ These routes are also why GitNexus's contract extraction finds three providers here and links none of
them: its consumers are each frontend's external geocoder call. See parent [`docs/gitnexus.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/docs/gitnexus.md).

## Related files

| Topic | File |
|---|---|
| rules for agents working in this repo | [`CLAUDE.md`](./CLAUDE.md) |
| git hooks, gate order, node selection | [`REPO.md`](./REPO.md) |
| the whole platform — tiers, ports, terminology | parent [`CLAUDE.md`](./CLAUDE.md) |

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).
