import { createMailThrottle } from '@axiumine/koa-utils/lib/access/createMailThrottle'
import { socketLabsVerifyEmailMailer, throttleMailer } from '@axiumine/koa-utils/lib/access/verifyEmailMailer'

/**
 * Every notification the registration flow sends, debounced per address.
 *
 * The mailer koa-utils built for its own verify-email chain, kept when the chain itself was replaced
 * (ADR-042). The templates and the `IVerifyEmailMailer` shape are unchanged, so a shop owner or a
 * customer receives exactly the mail they received before; only the code that decides *when* moved.
 *
 * ⚠️ **The throttle is the whole reason this is a module and not a `new SocketLabsLib()` at each call
 * site.** Three of these notifications are reachable from an unauthenticated `GET` and two from an
 * unauthenticated mutation, so without a debounce anybody who knows a registered address can make the
 * platform's own SocketLabs account mail its owner once per request — a mail bomb aimed at a third party,
 * out of a request nobody had to authenticate. `createMailThrottle` keeps one in-process window per
 * `<method>:<address>`; `sendWelcome` passes through it untouched, because it fires once on the success
 * path and swallowing it would cost somebody their welcome mail.
 *
 * One instance for the process, shared by submit, confirm and resend, so the three cannot each be a
 * separate window for the same address.
 */
export const registrationMailer = throttleMailer(socketLabsVerifyEmailMailer, createMailThrottle())
