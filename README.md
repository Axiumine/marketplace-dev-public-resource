# marketplace-dev-public-resource

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
| `search` | text search across the two indexed collections |
| `sitemapEntries` | what the SSR frontend builds `sitemap.xml` from |
| `publicHelloNoArgs`, `publicHelloArgs` | liveness probes, kept deliberately |

| Mutations | |
|---|---|
| `userRegister` | end-customer self-service registration — no approval step, unlike `ShopOwner` |
| `userVerifyEmailResend` | re-sends the confirmation mail |
| `userResetPwd`, `userUpdatePwd` | the reset flow's two halves |
| `publicMutNoArgs`, `publicMutArgs` | liveness probes |

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
