import Router from '@koa/router'
// Not `@axiumine/koa-utils/koa/router/verifyEmail`. That export is the same handler bound to the
// package's own `UserBase` model — collection `user`, which no migration on this platform creates —
// so the lookup found nothing whatever was asked of it and the route redirected every request to
// `/x/email-check`, correct hash or not. The local module is the same factory pointed at
// `ShopOwner`; see the paths map there.
import { routerVerifyEmail } from '@lib/access/verifyEmailFlow.mjs'
import { routerVerifyEmailUser } from '@lib/access/verifyEmailFlowUser.mjs'

const router = new Router({ prefix: '/check' })

router.get('/', async (ctx) => {
	ctx.body = ''
})

router.get('/verify-email/:email/:hash', routerVerifyEmail())

// ⚠️ A second route rather than a second handler on the first one. Both take an email and a hash and
// neither can tell from them which collection minted the pair, so one shared path would resolve to
// whichever flow matched first and report every link from the other tier as a bad hash — with the
// wrong-hash counter ticking towards disposing of a perfectly good registration. The customer's link
// is also built on `APP_DOMAIN_USER` rather than `APP_DOMAIN`, so the two differ in host as well as
// path and nginx needs no rewrite to route them. Keep the literal in step with
// `USER_VERIFY_LINK_PATH`, which is what the mail is built from.
router.get('/verify-email-user/:email/:hash', routerVerifyEmailUser())

export default router
