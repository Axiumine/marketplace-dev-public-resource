import Router from '@koa/router'
// Not `@axiumine/koa-utils/koa/router/verifyEmail`. That handler reads a half-built account document out
// of the package's own `UserBase` model — collection `user`, which no migration on this platform creates —
// and after ADR-042 there is no half-built document to read in any collection: a pending registration is a
// Redis record, and the click below is what creates the account.
import {
	routerConfirmShopOwnerRegistration,
	routerConfirmUserRegistration
} from '@lib/registration/confirmRegistrationRouter.mjs'

const router = new Router({ prefix: '/check' })

router.get('/', async (ctx) => {
	ctx.body = ''
})

router.get('/verify-email/:email/:hash', routerConfirmShopOwnerRegistration)

// ⚠️ A second route rather than a second handler on the first one. Both take an email and a hash and
// neither can tell from them which collection the pair was minted for — and the Redis key is derived from
// the tier as well as the address, so one shared path would look under whichever tier matched first and
// report every link from the other one as a dead link, with the wrong-hash counter ticking towards
// disposing of a perfectly good registration. The customer's link is also built on `APP_DOMAIN_USER`
// rather than `APP_DOMAIN`, so the two differ in host as well as path and nginx needs no rewrite to route
// them. Keep the literal in step with `USER_VERIFY_LINK_PATH`, which is what the mail is built from.
router.get('/verify-email-user/:email/:hash', routerConfirmUserRegistration)

export default router
