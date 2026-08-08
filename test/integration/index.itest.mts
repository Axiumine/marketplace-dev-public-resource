import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { createVerifyEmailFlow } from '@axiumine/koa-utils/lib/access/createVerifyEmailFlow'
import type { IVerifyEmailMailer } from '@axiumine/koa-utils/lib/access/verifyEmailMailer'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources); this is a
// belt-and-suspenders load so the values are present when this file's top level reads them.
dotenv.config()

import { ENDPOINT, start } from '../../src/index.mts'
import { VERIFY_EMAIL_PATHS } from '../../src/lib/access/verifyEmailFlow.mts'

const REDIS_KEY = process.env.REDIS_KEY as string

let httpServer: Server
let base: string

/** POST a GraphQL document to the real endpoint and return the parsed body. */
async function gql(query: string, variables?: Record<string, unknown>) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables })
	})

	return {
		status: res.status,
		json: (await res.json()) as {
			data?: Record<string, unknown>
			errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
		}
	}
}

/****************************************************************************************
 * Seeds for the resetPwd/updatePwd/verify-email describes below. Everything writes to this
 * service's own throwaway integration database (see vitest.mongo.mts), and every document
 * carries an `itest-…@marketplace.invalid` address besides, so it is also harmless if ever pointed
 * at a shared one. `_id`s are tracked at creation time and drained in afterAll.
 ****************************************************************************************/

const seededShopOwnerIds: mongoose.Types.ObjectId[] = []

/** The raw driver handle — only defined once start() has connected. */
function db() {
	return mongoose.connection.db!
}

function itestEmail() {
	return `itest-${randomUUID()}@marketplace.invalid`
}

/** Fixed-length filler, not a real bcrypt hash: the validator only checks the 60-char length,
 * and neither resetPwd nor updatePwd ever reads this field on the seeded document — updatePwd
 * only ever WRITES a new one, on the success path this file deliberately does not drive (see
 * the comment on the describe block below). */
const FAKE_PASSWORD_HASH = '$2b$14$' + 'x'.repeat(53)

/**
 * Inserted with the raw driver rather than the Mongoose model, the platform seeding convention:
 * the insert is then shaped by the collection's own `$jsonSchema` and by nothing else, so a seed
 * cannot inherit whatever the model happens to believe today. That is not hypothetical — the model
 * used to spell `personalData.birth.date` as `date` and carry no `contacts` path at all, both of
 * which the validator refuses under `additionalProperties: false`, so a model write failed outright
 * (fixed in marketplace-common 1.17.0). The raw path was never affected, and will not be by the next
 * drift either.
 *
 * `login` merges into the `login` sub-document; `extra` merges at the document root, which is
 * where the validator puts `disabled`, `deleted`, `resetPwd` and `emailVerify` (see marketplace-db-setup's
 * create-shopOwner migration and the later alter-shopOwner-emailVerify one) — a gate, a
 * pre-seeded reset request or a pending verification link all need this second bucket.
 */
async function seedShopOwner(login: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const email = itestEmail()
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('shopOwner')
		.insertOne({
			_id,
			login: { email, password: FAKE_PASSWORD_HASH, ...login },
			personalData: {
				firstName: 'Itest',
				lastName: 'PublicResource',
				birth: { date: new Date('1985-06-15T00:00:00Z') },
				address: { street: '2 Test Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
				contacts: { mobile: '3900000001', email }
			},
			registeredAt: new Date(),
			...extra
		})
	seededShopOwnerIds.push(_id)

	return { _id, email }
}

function shopOwnerById(_id: mongoose.Types.ObjectId) {
	return db().collection('shopOwner').findOne({ _id })
}

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB')
	httpServer = server.httpServer
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')
	base = `http://127.0.0.1:${address.port}`
})

/**
 * Cleanup must never abort halfway. `afterAll` drains MongoDB first and Redis second, so a single
 * failed delete — a cluster MOVED mid-resharding, a handle closed early — would otherwise strand
 * every id and key registered after it, and would skip the Redis drain entirely. Mongo residue is
 * harmless, globalSetup drops and re-migrates the database on the next run; a stranded Redis key
 * sits in the cluster for its whole TTL, which for a refresh session is 90 days.
 */
async function drainSafely(what: string, remove: () => Promise<unknown>) {
	try {
		await remove()
	} catch (error) {
		console.error(`[afterAll] cleanup failed for ${what}:`, error)
	}
}

afterAll(async () => {
	// Drop whatever this run created while the handles are still open. One document per id — the
	// index that would matter for a multi-key operation (CROSSSLOT) is a Redis concern; this loop
	// only ever touches MongoDB, but it keeps the same "one at a time" shape as the Redis cleanups
	// elsewhere in the platform for consistency.
	for (const _id of seededShopOwnerIds) {
		await drainSafely(`shopOwner ${_id.toString()}`, () => db().collection('shopOwner').deleteOne({ _id }))
	}
	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
})

describe('public-resource service (integration, real MongoDB + real Redis cluster)', () => {
	// start() is what wires both datasources; asserting the live handles is what makes the rest of
	// this file an integration suite rather than an in-process schema test.
	it('has a live MongoDB connection', () => {
		expect(mongoose.connection.readyState).toBe(1)
	})

	it('has a live Redis cluster connection, round-tripping a key in the isolated namespace', async () => {
		const key = `${REDIS_KEY}itest:${randomUUID()}`

		// EX so this one cannot outlive the run. It is never registered for the afterAll drain, so
		// without a TTL a hard kill — or a throw on the assertion below — strands it on the cluster
		// forever. 60s is far longer than the round trip and short enough to be self-cleaning.
		await redisClient.set(key, 'pong', { EX: 60 })
		expect(await redisClient.get(key)).toBe('pong')

		await redisClient.del(key)
		expect(await redisClient.get(key)).toBeNull()
	})
})

describe('GraphQL over HTTP', () => {
	it('serves the no-args query', async () => {
		const { status, json } = await gql('{ publicHelloNoArgs { txt } }')

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ publicHelloNoArgs: { txt: 'Hello from publicHelloNoArgs' } })
	})

	it('serves the args query', async () => {
		const { json } = await gql('query ($name: String!) { publicHelloArgs(name: $name) { txt } }', { name: 'Luigi' })

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ publicHelloArgs: { txt: 'Hello from publicHelloArgs - Luigi!' } })
	})

	it('serves the no-args mutation', async () => {
		const { json } = await gql('mutation { publicMutNoArgs }')

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ publicMutNoArgs: 'publicMutNoArgs' })
	})

	it('serves the args mutation', async () => {
		const { json } = await gql('mutation ($name: String!) { publicMutArgs(name: $name) }', { name: 'Mark' })

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ publicMutArgs: 'publicMutArgs Mark' })
	})

	// Introspection stays open outside production (buildValidationRules returns no rules), and the
	// schema it reports is the one really assembled in createServer — not a copy rebuilt by a test.
	it('exposes the assembled schema through introspection', async () => {
		const { json } = await gql('{ __schema { queryType { name } mutationType { name } } }')

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ __schema: { queryType: { name: 'QueriesPublic' }, mutationType: { name: 'MutationsPublic' } } })
	})

	it('rejects a GET on the GraphQL endpoint (csrfPrevention / method not allowed)', async () => {
		const res = await fetch(`${base}${ENDPOINT}?query=%7B__typename%7D`)

		expect(res.status).toBeGreaterThanOrEqual(400)
	})
})

// Both halves of the reset really hit MongoDB — including mongoose.startSession() and
// withTransaction, which need the replica set. An address that does not exist is used on purpose:
// resetPwd answers true without persisting or mailing anything (no enumeration oracle), and
// updatePwd answers 403 for the same reason. Neither writes.
describe('reset-password flow bound to the shopOwner collection', () => {
	const unknownEmail = `itest-${randomUUID()}@marketplace.invalid`

	it('resetPwd answers true for an unknown address, without sending anything', async () => {
		const { json } = await gql('mutation ($email: String!) { resetPwd(email: $email) }', { email: unknownEmail })

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ resetPwd: true })
	})

	it('updatePwd is forbidden for an unknown address', async () => {
		const { json } = await gql(
			'mutation ($e: String!, $h: String!, $p: String!) { updatePwd(email: $e, hash: $h, password: $p) }',
			{
				e: unknownEmail,
				h: 'x'.repeat(32),
				p: 'Str0ngPwd!2026'
			}
		)

		expect(json.errors).toBeDefined()
		expect(json.data?.updatePwd ?? null).toBeNull()
	})
})

// The describe above only ever reaches the "email not found" branch of resetPwd/updatePwd — the
// one pair of branches that never touches a real document. Everything below seeds a real
// shopOwner through the raw driver and reads it back, to prove the OTHER branches for real:
// the account-state gate (deleted/disabled), the 10-minute resend throttle, and updatePwd's
// hash/expiry checks.
//
// Deliberately NOT driven here: either mutation's full SUCCESS path (a brand-new resetPwd
// request, or a completed updatePwd). Both end by really calling SocketLabsLib with the live
// SOCKETLABS_SERVER_ID/SERVER_APIKEY this service loads from .env (see the workspace CLAUDE.md's
// protected-secrets list) — resetPwd's send is fire-and-forget so it would not even block this
// suite, but updatePwd's confirmation IS awaited before the mutation returns. Firing a real send
// through the production email account from an automated test run is a materially different kind
// of side effect than a write to this service's own throwaway database, so it is listed under
// "uncovered" in the report rather than exercised here without a decision from whoever owns that
// account.
describe('resetPwd / updatePwd against a real seeded shopOwner (refusal branches)', () => {
	const resetPwdMutation = 'mutation ($email: String!) { resetPwd(email: $email) }'
	const updatePwdMutation = 'mutation ($e: String!, $h: String!, $p: String!) { updatePwd(email: $e, hash: $h, password: $p) }'

	/**
	 * Every refusal branch below makes the same three claims — the mutation errors, it resolves to
	 * null, and the seeded hash is still the stored password afterwards — and differs only in *why*
	 * the request was refused. The document is returned so each test can add the check that is its
	 * own reason for existing.
	 */
	async function expectUpdatePwdRefused(_id: mongoose.Types.ObjectId, email: string, hash: string) {
		const { json } = await gql(updatePwdMutation, { e: email, h: hash, p: 'Str0ngPwd!2026' })
		expect(json.errors).toBeDefined()
		expect(json.data?.updatePwd ?? null).toBeNull()

		const doc = await shopOwnerById(_id)
		expect(doc?.login.password).toBe(FAKE_PASSWORD_HASH)

		return doc
	}

	it('resetPwd leaves a disabled account untouched: true is returned, no resetPwd sub-document is written', async () => {
		const { _id, email } = await seedShopOwner({}, { disabled: true })

		const { json } = await gql(resetPwdMutation, { email })
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ resetPwd: true })

		// getResetPwd (see koa-utils getResetPwd.mjs) answers null for a disabled account, exactly
		// as it does for an unknown one — so resetPwd returns before saveResetReq is ever called.
		const doc = await shopOwnerById(_id)
		expect(doc?.resetPwd).toBeUndefined()
	})

	it('resetPwd leaves a deleted account untouched: true is returned, no resetPwd sub-document is written', async () => {
		const { _id, email } = await seedShopOwner({}, { deleted: new Date() })

		const { json } = await gql(resetPwdMutation, { email })
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ resetPwd: true })

		const doc = await shopOwnerById(_id)
		expect(doc?.resetPwd).toBeUndefined()
	})

	// The 10-minute throttle (see koa-utils resetPwd.mjs) compares "now" against a real stored
	// resetDateReq: only a document already carrying one, read back through Mongo, can prove the
	// "too soon, don't regenerate" branch instead of the "first request" one.
	it('resetPwd throttles a resend requested less than 10 minutes after the last one: the stored hash is left exactly as seeded', async () => {
		const seededHash = 'a'.repeat(50)
		const { _id, email } = await seedShopOwner(
			{},
			{ resetPwd: { resetDateReq: new Date(Date.now() - 2 * 60 * 1000), resetHash: seededHash } }
		)

		const { json } = await gql(resetPwdMutation, { email })
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ resetPwd: true })

		const doc = await shopOwnerById(_id)
		expect(doc?.resetPwd.resetHash).toBe(seededHash)
	})

	it('updatePwd refuses a wrong hash: 403, and neither the password nor the pending request are touched', async () => {
		const seededHash = 'b'.repeat(50)
		const { _id, email } = await seedShopOwner({}, { resetPwd: { resetDateReq: new Date(), resetHash: seededHash } })

		const doc = await expectUpdatePwdRefused(_id, email, 'c'.repeat(50))
		expect(doc?.resetPwd.resetHash).toBe(seededHash)
	})

	it('updatePwd refuses a link older than 60 minutes even with the correct hash: 403, nothing is touched', async () => {
		const seededHash = 'd'.repeat(50)
		const { _id, email } = await seedShopOwner(
			{},
			{ resetPwd: { resetDateReq: new Date(Date.now() - 61 * 60 * 1000), resetHash: seededHash } }
		)

		const doc = await expectUpdatePwdRefused(_id, email, seededHash)
		expect(doc?.resetPwd.resetHash).toBe(seededHash)
	})

	// getResetPwd answers resetHash: null whenever resetDateReq is undefined — i.e. an account that
	// exists but has never requested a reset. koa-utils answers the SAME 403 as an unknown address
	// on purpose (see applyPasswordReset's own comment): a different status here would let
	// updatePwd enumerate registered accounts by which email holds a pending reset.
	it('updatePwd refuses an account with no pending reset request at all: the same 403 as an unknown address', async () => {
		const { email } = await seedShopOwner()

		const { json } = await gql(updatePwdMutation, { e: email, h: 'e'.repeat(50), p: 'Str0ngPwd!2026' })
		expect(json.errors).toBeDefined()
		expect(json.data?.updatePwd ?? null).toBeNull()
	})

	it('updatePwd refuses a disabled account even with a correct, unexpired hash: password is left exactly as seeded', async () => {
		const seededHash = 'f'.repeat(50)
		const { _id, email } = await seedShopOwner(
			{},
			{ disabled: true, resetPwd: { resetDateReq: new Date(), resetHash: seededHash } }
		)

		await expectUpdatePwdRefused(_id, email, seededHash)
	})
})

/*
 * The route this block covers used to be documented here as an outright bug, and the two tests below
 * are what is left of that report once it was fixed. The handler mounted at
 * `GET /check/verify-email/:email/:hash` was koa-utils' own `routerVerifyEmail()` export — the one
 * pre-bound to its bundled `UserBase` model, collection 'user', with DEFAULT_VERIFY_EMAIL_PATHS. No
 * migration on this platform creates a 'user' collection, so `userData4VerifyEmail` always answered
 * null and the route always took the "email not found" branch: no verification link ever worked, for
 * anyone, including one carrying a correct hash for a real account.
 *
 * It is now built by `createVerifyEmailFlow` in src/lib/access/verifyEmailFlow.mts, the same shape
 * resetPwdFlow.mts uses, against the `emailVerify` sub-document added to the collection by
 * marketplace-db-setup's 20260726000000-alter-shopOwner-emailVerify migration.
 *
 * Every test here drives the MOUNTED route, so it runs the production flow — SocketLabs mailer and
 * all. That limits it to the two branches that send nothing: `userData4VerifyEmail`'s not-found path,
 * which only calls `Sentry.captureMessage` (a no-op here — src/instrument.mts is never imported by the
 * integration project) before throwing EMAIL_CHECK_LINK, and `handleBadDB`, which does the same. The
 * rest of the chain is driven against the same collection in the next describe, through a flow built
 * with a recording mailer.
 *
 * ⚠️ All three redirect to the SAME page, and that is a fix rather than a loss of resolution. Through
 * koa-utils 5.6.1 `handleBadDB` threw '/x/error' while an unknown address threw EMAIL_CHECK_LINK, and
 * the pair answered an unauthenticated GET with two distinguishable responses — on data predating the
 * verification fields, where every real shopOwner hit handleBadDB and every unknown address did
 * not, that was a clean account-existence oracle. 5.7.0 sends both to EMAIL_CHECK_LINK and keeps the
 * distinction in Sentry. The proof that the lookup lands on `shopOwner` therefore moved off the
 * redirect and onto the database: the seeded document is read back below, and the chain describe that
 * follows writes to it.
 */
describe('GET /check/verify-email/:email/:hash bound to the shopOwner collection', () => {
	it('redirects to the email-check page for an address that belongs to no shopOwner', async () => {
		const res = await fetch(`${base}/check/verify-email/${encodeURIComponent(itestEmail())}/${'x'.repeat(50)}`)

		expect(res.redirected).toBe(true)
		expect(res.url).toBe(`${base}/x/email-check`)
	})

	it('reaches a real shopOwner, stops at handleBadDB, and writes nothing', async () => {
		// No `emailVerify` at all: the shopOwner exists but has never been sent a verification link.
		// userData4VerifyEmail projects hash/valid/dateLastReq/requestTimes/deleted/disabled, .lean()
		// returns undefined for the absent ones, and handleBadDB reads a missing requestTimes as
		// corrupt state rather than "never requested" — so it throws before any guard that would
		// construct a SocketLabsLib runs.
		const { _id, email } = await seedShopOwner()

		const res = await fetch(`${base}/check/verify-email/${encodeURIComponent(email)}/${'x'.repeat(50)}`)

		expect(res.redirected).toBe(true)
		expect(res.url).toBe(`${base}/x/email-check`)

		// enableEmailAccess was never reached: nothing was written to the seeded document.
		const doc = await shopOwnerById(_id)
		expect(doc?.login.email).toBe(email)
		expect(doc?.emailVerify).toBeUndefined()
	})

	// The same guard, one step further in: `hash` and `dateLastReq` present, `requestTimes` absent.
	// handleBadDB checks requestTimes and dateLastReq independently, and a hash stored without its
	// strike counter is exactly the corrupt state it exists to catch — a wrong-hash attempt would
	// otherwise increment `undefined`. This is a real emailVerify sub-document being read back through
	// the paths map, so it also pins that VERIFY_EMAIL_PATHS resolves against the live validator.
	it('stops at handleBadDB for an emailVerify holding a hash but no requestTimes', async () => {
		const { _id, email } = await seedShopOwner({}, { emailVerify: { hash: 'x'.repeat(50), dateLastReq: new Date() } })

		const res = await fetch(`${base}/check/verify-email/${encodeURIComponent(email)}/${'x'.repeat(50)}`)

		expect(res.redirected).toBe(true)
		expect(res.url).toBe(`${base}/x/email-check`)

		// The stored hash is untouched and `valid` was never set — the guard fired before the write.
		const doc = await shopOwnerById(_id)
		expect(doc?.emailVerify.hash).toBe('x'.repeat(50))
		expect(doc?.emailVerify.valid).toBeUndefined()
	})
})

/*
 * The rest of the chain, against the same collection and the same paths map, through a flow built here
 * with a recording mailer instead of SocketLabs.
 *
 * This describe exists because koa-utils 5.7.0 made it possible. Through 5.6.1 every guard constructed
 * its own `SocketLabsLib` inline and `enableEmailAccess` sent the welcome mail itself, so no branch
 * past the two above could be reached without mailing a real address from the live production account
 * — the success path included. `mailer` is now an option, and a flow that records instead of sending
 * turns the whole chain into something a real database can be pointed at.
 *
 * The flow is built here rather than imported, because the production one is bound to the real mailer
 * at module load. What keeps that honest is the unit suite: test/verifyEmailFlow.test.mts asserts the
 * exact argument object src/lib/access/verifyEmailFlow.mts passes, so the only difference between the
 * two flows is the `mailer` key added below. Everything else — model, paths, disposal policy — is
 * imported from the module under test rather than restated.
 */
describe('verify-email chain against real MongoDB, with a recording mailer', () => {
	const sent: Array<[string, string]> = []

	const recordingMailer: IVerifyEmailMailer = {
		emailAlreadyValid: async (email) => void sent.push(['emailAlreadyValid', email]),
		wrongHash: async (email) => void sent.push(['wrongHash', email]),
		tooMuchVerifyRequests: async (email) => void sent.push(['tooMuchVerifyRequests', email]),
		hashReqTooOld: async (email) => void sent.push(['hashReqTooOld', email]),
		accountDisabled: async (email) => void sent.push(['accountDisabled', email]),
		sendWelcome: async (email) => void sent.push(['sendWelcome', email])
	}

	const flow = createVerifyEmailFlow({
		model: ShopOwner,
		paths: VERIFY_EMAIL_PATHS,
		onAbandon: 'soft-delete',
		deletedValue: () => new Date(),
		mailer: recordingMailer
	})

	/**
	 * Drive the real handler with the smallest ctx @koa/router would hand it: the route reads
	 * `ctx.params` and calls `ctx.redirect`, and nothing else. Returning the redirect target rather
	 * than asserting on a Response keeps this identical in shape to the mounted-route tests above.
	 */
	async function callRoute(email: string, hash: string) {
		let target = ''
		const ctx = { params: { email, hash }, redirect: (to: string) => void (target = to) }

		await flow.routerVerifyEmail()(ctx as never)

		return target
	}

	const VALID_HASH = 'a'.repeat(50)

	it('honours a correct link: sets valid, clears the three token members, sends the welcome', async () => {
		const { _id, email } = await seedShopOwner(
			{},
			{ emailVerify: { hash: VALID_HASH, dateLastReq: new Date(), requestTimes: 1 } }
		)

		expect(await callRoute(email, VALID_HASH)).toBe('/x/registration-done')

		// `valid` survives and the three token members are gone — which is the whole reason
		// VERIFY_EMAIL_PATHS.verifyClear lists leaves rather than the `emailVerify` container.
		const doc = await shopOwnerById(_id)
		expect(doc?.emailVerify).toEqual({ valid: true })
		expect(sent).toContainEqual(['sendWelcome', email])
	})

	it('counts a wrong hash as a strike and leaves the account otherwise untouched', async () => {
		const { _id, email } = await seedShopOwner(
			{},
			{ emailVerify: { hash: VALID_HASH, dateLastReq: new Date(), requestTimes: 1 } }
		)

		expect(await callRoute(email, 'b'.repeat(50))).toBe('/x/email-check')

		const doc = await shopOwnerById(_id)
		expect(doc?.emailVerify.requestTimes).toBe(2)
		expect(doc?.emailVerify.valid).toBeUndefined()
		expect(doc?.deleted).toBeUndefined()
		expect(sent).toContainEqual(['wrongHash', email])
	})

	// The reason the koa-utils change was asked for. Through 5.6.1 this branch was a hard `deleteOne`,
	// and on `shopOwner` that removed the document while its `company` → `item` → `itemCategory` chain
	// kept pointing at an idShopOwner that no longer resolved. The document surviving with a
	// tombstone is the assertion; that the tombstone is a Date the strict validator accepts is the
	// other half, and it is why `deletedValue` cannot be koa-utils' boolean default.
	it('soft-deletes on the fifth strike: the document survives, tombstoned with a Date', async () => {
		const { _id, email } = await seedShopOwner(
			{},
			{ emailVerify: { hash: VALID_HASH, dateLastReq: new Date(), requestTimes: 5 } }
		)

		expect(await callRoute(email, VALID_HASH)).toBe('/x/email-check')

		const doc = await shopOwnerById(_id)
		expect(doc).not.toBeNull()
		expect(doc?.deleted).toBeInstanceOf(Date)
		expect(doc?.emailVerify.hash).toBe(VALID_HASH)
		expect(sent).toContainEqual(['tooMuchVerifyRequests', email])
	})

	it('soft-deletes a link older than three days, correct hash and all', async () => {
		const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
		const { _id, email } = await seedShopOwner(
			{},
			{ emailVerify: { hash: VALID_HASH, dateLastReq: fourDaysAgo, requestTimes: 1 } }
		)

		expect(await callRoute(email, VALID_HASH)).toBe('/x/email-check')

		const doc = await shopOwnerById(_id)
		expect(doc).not.toBeNull()
		expect(doc?.deleted).toBeInstanceOf(Date)
		expect(sent).toContainEqual(['hashReqTooOld', email])
	})

	it('refuses a second use of an already-honoured link without touching the document', async () => {
		const { _id, email } = await seedShopOwner({}, { emailVerify: { valid: true } })

		expect(await callRoute(email, VALID_HASH)).toBe('/x/email-check')

		// handleIfEmailAlreadyValid is the first guard, so nothing further ran: no strike, no tombstone.
		const doc = await shopOwnerById(_id)
		expect(doc?.emailVerify).toEqual({ valid: true })
		expect(doc?.deleted).toBeUndefined()
		expect(sent).toContainEqual(['emailAlreadyValid', email])
	})

	it('refuses a disabled account after the hash has already checked out', async () => {
		const { _id, email } = await seedShopOwner(
			{},
			{ disabled: true, emailVerify: { hash: VALID_HASH, dateLastReq: new Date(), requestTimes: 1 } }
		)

		expect(await callRoute(email, VALID_HASH)).toBe('/x/email-check')

		// The account-state gate runs last, so a disabled shopOwner gets this far with a correct
		// hash and is still refused — and `valid` was never flipped.
		const doc = await shopOwnerById(_id)
		expect(doc?.emailVerify.valid).toBeUndefined()
		expect(sent).toContainEqual(['accountDisabled', email])
	})
})

describe('non-GraphQL routes', () => {
	it('serves /health', async () => {
		const res = await fetch(`${base}/health`)

		expect(res.status).toBe(200)
		const json = (await res.json()) as { status: string; timestamp: string }
		expect(json.status).toBe('OK')
		expect(json.timestamp).toBe(new Date(json.timestamp).toISOString())
	})

	it('mounts the /check router', async () => {
		const res = await fetch(`${base}/check/`)

		expect(res.status).toBe(200)
		expect(await res.text()).toBe('')
	})

	it('falls through to 404 for an unknown path', async () => {
		const res = await fetch(`${base}/nope`)

		expect(res.status).toBe(404)
	})
})
