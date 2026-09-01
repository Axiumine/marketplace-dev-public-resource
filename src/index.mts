import { ApolloServer } from '@apollo/server'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { koaMiddleware as apolloServerKoa } from '@as-integrations/koa'
import { MongoDBConnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { tdwKoaErrorHandler } from '@axiumine/koa-utils/koa/tdwKoaErrorHandler'
import { setupFieldEncryption } from '@axiumine/marketplace-common/encryption/setupFieldEncryption'
import type { EnvShape } from '@axiumine/marketplace-common/others/assertEnvShape'
import { assertEnvShape } from '@axiumine/marketplace-common/others/assertEnvShape'
import { assertRedisNamespace } from '@axiumine/marketplace-common/others/assertRedisNamespace'
import { disconnectAllDatabases } from '@lib/db/disconnectAllDatabases.mjs'
import * as Sentry from '@sentry/node'
import { GraphQLSchema, NoSchemaIntrospectionCustomRule, ValidationRule } from 'graphql'
import depthLimit from 'graphql-depth-limit'
import http from 'http'
import Koa, { Context, Next } from 'koa'
import bodyParserKoa from 'koa-bodyparser'

import MutationsPublic from './graphQLPublic/schema/mutations.mjs'
import QueriesPublic from './graphQLPublic/schema/queries.mjs'
import router from './middleware/router/index.mjs'

export const ENDPOINT = '/public-resource'

// `DSN` is deliberately NOT in this list. Sentry is optional: `Sentry.init({ dsn: undefined })` is a
// no-op, so a missing telemetry credential must never stop the service from serving. Requiring it made
// boot fail *silently* — checkRequiredEnv() runs outside start()'s try, so the throw reached only the
// top-level `.catch`, which reports to the very Sentry client the missing DSN had just disabled.
export const REQUIRED_ENV_VARS = [
	'PORT',
	'REDIS_IS_CLUSTER',
	'REDIS_DB1_HOST',
	'REDIS_DB2_HOST',
	'REDIS_DB3_HOST',
	'REDIS_DB1_PORT',
	'REDIS_DB2_PORT',
	'REDIS_DB3_PORT',
	'REDIS_USERNAME',
	'REDIS_PASSWORD',
	'REDIS_KEY',
	'MONGODB_URI',
	// The two halves of the field-encryption setup: where the 96-byte master key lives, and which
	// namespace holds the data encryption keys it wraps. ADR-029. Both are read by
	// setupFieldEncryption() below, and both belong in this list rather than being defaulted — a
	// service that booted without them would read every personal field as raw `binData` and write
	// plaintext beside the ciphertext already there.
	'CSFLE_MASTER_KEY_PATH',
	'CSFLE_KEY_VAULT_NAMESPACE',
	// ⚠️ Everything `SocketLabsLib`'s constructor reads, plus the two domains this service's own call
	// sites pass it. This is the only service that sends mail — registration verification for both
	// `shopOwner` and `user`, and the "your address is already verified" reply — and it once required
	// none of these while two services that send no mail required the credential pair. The failure that
	// hid it is quiet: `SocketLabsLib` reads the key into a template literal, so an unset variable becomes
	// the string `"undefined"`, the client builds, and the first registration email of the deployment is
	// the thing that fails. `APP_DOMAIN` is the shop-owner link base and `APP_DOMAIN_USER` the customer
	// one — swapping them sends each tier to the other's front door.
	'SOCKETLABS_SERVER_ID',
	'SOCKETLABS_SERVER_APIKEY',
	'PLATFORM_NAME',
	'EMAIL_FROM',
	'APP_DOMAIN',
	'APP_DOMAIN_USER'
]

/**
 * The *kind* of value each name must hold, checked by `assertEnvShape` after the presence loop above.
 * Presence and shape are two passes on purpose: a name may be shaped without being required, which is
 * what lets `REDIS_URL` appear here and in no list.
 *
 * ⚠️ **A name absent from this map is unconstrained, and five are deliberately absent.**
 * `REDIS_USERNAME`, `REDIS_PASSWORD` and `SOCKETLABS_SERVER_APIKEY` are free strings — a credential has
 * no format, and a rule invented for one would refuse a legal one. `SOCKETLABS_SERVER_ID` is whatever
 * the provider issued and `PLATFORM_NAME` whatever the platform owner named it: a spelling rule for
 * either would be one this file invented rather than one it was given.
 *
 * What this catches is an environment filled in from somewhere else — a Mongo URI in the Redis slot,
 * `true` where koa-utils compares against `'1'`, a host name carrying a scheme, a port with a typo in
 * it. All four are truthy, so the loop above passes every one of them. A plausible wrong value of the
 * right shape still passes and always will, because no check this process runs knows what the rest of
 * the fleet was pointed at: that residual is the open half of `RISK_REGISTER` R04.
 */
export const ENV_SHAPES: Readonly<Record<string, EnvShape>> = {
	PORT: 'port',
	REDIS_IS_CLUSTER: 'flag01',
	/*
	 * ⚠️ Shaped here and required nowhere. Its presence rule is the conditional at the foot of
	 * `checkRequiredEnv`, because the cluster branch never reads it and the committed `env` template ships
	 * it empty — a shape pass that also demanded presence would refuse the very machines this workspace
	 * ships configured. `assertEnvShape` skips an absent or empty value for exactly this case.
	 */
	REDIS_URL: 'redisUrl',
	REDIS_DB1_HOST: 'hostname',
	REDIS_DB2_HOST: 'hostname',
	REDIS_DB3_HOST: 'hostname',
	REDIS_DB1_PORT: 'port',
	REDIS_DB2_PORT: 'port',
	REDIS_DB3_PORT: 'port',
	REDIS_KEY: 'keyPrefix',
	MONGODB_URI: 'mongoUri',
	CSFLE_MASTER_KEY_PATH: 'absolutePath',
	CSFLE_KEY_VAULT_NAMESPACE: 'namespace',
	EMAIL_FROM: 'email',
	APP_DOMAIN: 'origin',
	APP_DOMAIN_USER: 'origin'
}

/**
 * Fail fast if any required environment variable is missing.
 */
export function checkRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const envVar of REQUIRED_ENV_VARS) {
		if (!env[envVar]) {
			const message = `Missing required environment variable: ${envVar}`
			// await adminLog(message, LogLevel.fatal)
			throw new Error(message)
		}
	}

	/*
	 * ⚠️ **`REDIS_URL` is required on the single-node branch and on that branch only**, which is why it is checked
	 * here instead of being listed above. `REDIS_IS_CLUSTER=1` builds the cluster client out of the three
	 * `REDIS_DB*` pairs and never reads it — the committed `env` template ships it empty for exactly that reason,
	 * so a flat entry in the list would refuse the boot of a machine that is configured correctly.
	 *
	 * Any other value takes the `createClient({ url: resolveRedisUrl(REDIS_URL) })` branch, where node-redis
	 * answers an unset url with its own default of `redis://localhost:6379`. Empty is not an error there: the
	 * service connects to whatever happens to listen on this machine, writes every session into it and reports
	 * itself healthy, which is a wrong-but-populated environment nothing downstream can tell from a right one
	 * (`RISK_REGISTER` R04). `SETUP.md` puts a fresh machine on precisely that branch.
	 */
	if (env.REDIS_IS_CLUSTER !== '1' && !env.REDIS_URL) throw new Error('Missing required environment variable: REDIS_URL')

	/*
	 * Shape last, and only once every name that must be present is. A value that is absent is a
	 * different fault from a value that is the wrong kind of thing, and reporting the second while the
	 * first is outstanding sends an admin to fix a variable they have not written yet.
	 */
	assertEnvShape(ENV_SHAPES, env)
}

/**
 * Production hardens the schema: no introspection and a query-depth cap.
 * Everywhere else the rules are empty so the playground/tooling stays usable.
 */
export function buildValidationRules(env: NodeJS.ProcessEnv = process.env): ValidationRule[] {
	return env.NODE_ENV === 'production' ? [NoSchemaIntrospectionCustomRule, depthLimit(10)] : []
}

/**
 * Body of the /health endpoint. Kept pure so it is trivially testable — it cannot
 * throw, which is why the old try/catch around it was removed as dead code.
 */
export function healthResponse(): { status: string; timestamp: string } {
	return { status: 'OK', timestamp: new Date().toISOString() }
}

/**
 * Log the listening banner; in production also mirror it to Sentry as an info event.
 */
export function logListening(env: NodeJS.ProcessEnv = process.env): void {
	const message = `Serving http://*:${env.PORT}${ENDPOINT} for ${env.NODE_ENV}.`
	if (env.NODE_ENV === 'production') Sentry.captureMessage(message, 'info')
	console.info(message)
}

/**
 * Drain Apollo, close the HTTP server, then disconnect the datasources and exit.
 */
export const gracefulShutdown = async (signal: string, apolloServer: ApolloServer, httpServer: http.Server) => {
	Sentry.captureMessage(`${signal} received, shutting down gracefully...`)
	await apolloServer.stop()
	httpServer.close(() => disconnectAllDatabases(0))
}

export function onUnhandledRejection(reason: unknown): void {
	Sentry.captureException(reason)
	process.exit(1)
}

export function onUncaughtException(error: unknown): void {
	Sentry.captureException(error)
	process.exit(1)
}

/**
 * Build the Koa app + Apollo + HTTP server and start Apollo, WITHOUT connecting the
 * datasources or listening. Returned handles let callers (and tests) drive the server.
 */
export async function createServer() {
	/****************
	 * KOA
	 */
	const app = new Koa()
	// app.use(logger()) // useful only for log time to console
	app.use(tdwKoaErrorHandler)
	//app.use(debugHandler())
	app.use(router.routes())
	app.use(router.allowedMethods())

	app.use(
		bodyParserKoa({
			enableTypes: ['json', 'form', 'text'],
			// Exclude multipart requests that graphqlUploadKoa will handle
			extendTypes: {
				json: ['application/json']
			}
		})
	) // needed by Apollo too

	/****************
	 * KOA ENDPOINT
	 */
	// Use apolloServerKoa with custom endpoint
	app.use(async (ctx: Context, next: Next) => {
		if (ctx.path === ENDPOINT) {
			// @ts-expect-error TS2769: No overload matches this call.
			const middleware = apolloServerKoa(apolloServer, {
				async context() {
					return ctx
				}
			})
			return middleware(ctx, next)
		} else if (ctx.path === '/health') {
			ctx.body = healthResponse()
			ctx.status = 200
			return
		} else {
			await next()
		}
	})

	/****************
	 * APOLLO
	 */
	const httpServer = http.createServer(app.callback())

	// Create an instance of GraphQLSchema
	const graphQLSchema = new GraphQLSchema({
		query: QueriesPublic,
		mutation: MutationsPublic
	})

	const apolloServer = new ApolloServer({
		schema: graphQLSchema,
		plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
		// formatError: customFormatErrorFn
		// cache
		validationRules: buildValidationRules(),
		csrfPrevention: true
	})

	await apolloServer.start()

	return { app, httpServer, apolloServer }
}

/**
 * Full boot: validate env, connect the datasources, build the server and listen.
 * Returns the handles on success; on failure disconnects and exits.
 */
export async function start() {
	checkRequiredEnv()

	try {
		/****************
		 * DB
		 */
		await Promise.all([MongoDBConnect(), RedisConnect()])

		/****************
		 * Redis namespace (ADR-034)
		 *
		 * The first thing asked of the connection, because `REDIS_KEY` is a prefix and there is no wrong value
		 * Redis itself refuses. This service authenticates nobody, and three things it owns still live under that
		 * prefix: the pending registration a confirmation link has to find again, the per-email rate-limit
		 * counters, and the revocation `updatePwd` fires. A prefix naming a namespace nobody seeded used to cost
		 * it nothing at boot — every confirmation would report an expired link, every rate limit would start from
		 * zero, and a password change would leave the account's live sessions standing, all while the service
		 * reported itself healthy. The five services that call `loadKeygrip` already fail here; this is the same
		 * refusal for a tier that reads no key material.
		 *
		 * Presence only — unwrapping the record is `readKeygrip`'s business, on behalf of the services that sign.
		 * It cannot see a fleet-wide wrong prefix, which is `RISK_REGISTER` R04 and is not a question a service
		 * can ask about itself.
		 */
		await assertRedisNamespace(redisClient)

		/****************
		 * Field encryption (ADR-029)
		 *
		 * After MongoDBConnect() and before anything can query: it reuses the connection mongoose has
		 * just opened, and the models refuse to read or write a personal field until it has run. It
		 * throws rather than warning if the master key is missing — a service that started without it
		 * would write plaintext into collections whose other documents are ciphertext, and nothing
		 * would show that up until someone read the data back.
		 */
		await setupFieldEncryption()

		const { httpServer, apolloServer } = await createServer()

		/****************
		 * START SERVER
		 */
		await new Promise<void>((resolve) => {
			httpServer.listen(
				{
					port: process.env.PORT
					// No host: bind every interface on purpose. This used to pass a hostname key, which is not
					// a net.Server.listen option — Node ignored it and bound the unspecified address anyway, so
					// HOSTNAME never had any effect. Binding wide is the intent; the dead key only hid it.
				},
				() => {
					logListening()
					resolve()
				}
			)
		})

		return { httpServer, apolloServer }
	} catch (error) {
		console.error('error', error)
		Sentry.captureException(error) // @fixme does not send the log — check!
		await disconnectAllDatabases(1)
	}
}

/* v8 ignore start -- entrypoint wiring: executes only as the real process, never under test (NODE_ENV=test) */
if (process.env.NODE_ENV !== 'test') {
	// Handle unhandled promise rejections / uncaught exceptions
	process.on('unhandledRejection', onUnhandledRejection)
	process.on('uncaughtException', onUncaughtException)

	start()
		.then((srv) => {
			if (srv) {
				// Handle termination signals once the server is up
				process.on('SIGTERM', () => gracefulShutdown('SIGTERM', srv.apolloServer, srv.httpServer))
				process.on('SIGINT', () => gracefulShutdown('SIGINT', srv.apolloServer, srv.httpServer))
			}
		})
		.catch((e: unknown) => {
			/*
			 * ⚠️ The exit code is the whole point, and it used to be **0**. `checkRequiredEnv()` throws
			 * outside `start()`'s own try, so a missing variable lands here rather than in the
			 * disconnect-and-exit inside it — and this handler ended with a Sentry call and nothing else.
			 * Node then ran out of work and left with a success code: a service that never bound its port
			 * reported a clean shutdown to Docker, to systemd and to any restart policy reading `$?`, so a
			 * boot that failed was indistinguishable from one that was asked to stop. Sentry cannot stand in
			 * for the code either — with no DSN configured the SDK discards the event, which is the state
			 * this platform boots in. Say it where the container's own logs are, then leave with 1.
			 */
			console.error('fatal: the service could not start', e)
			Sentry.captureException(e)
			process.exit(1)
		})
}
/* v8 ignore stop */
