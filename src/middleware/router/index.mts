import Router from '@koa/router'
// Not `@axiumine/koa-utils/koa/router/verifyEmail`. That export is the same handler bound to the
// package's own `UserBase` model — collection `user`, which no migration on this platform creates —
// so the lookup found nothing whatever was asked of it and the route redirected every request to
// `/x/email-check`, correct hash or not. The local module is the same factory pointed at
// `Imprenditore`; see the paths map there.
import { routerVerifyEmail } from '@lib/access/verifyEmailFlow.mjs'

const router = new Router({ prefix: '/check' })

router.get('/', async (ctx) => {
	ctx.body = ''
})

router.get('/verify-email/:email/:hash', routerVerifyEmail())

export default router
