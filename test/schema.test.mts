import { graphql, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Imported dynamically inside beforeEach, not at module top level and not in beforeAll. A
// top-level import runs during Vitest's file-collection phase, before any test executes: a
// mutant in one of these modules' static GraphQL config (a `description`/`name` literal, or the
// whole config object) does its damage at that same collection-time evaluation, which Stryker's
// perTest coverage analysis cannot attribute to any test - the mutant is reported Survived even
// though the assertions below plainly fail against it. beforeAll is not enough either: wiping the
// config object empties `name`, and graphql-js's `devAssert` throws "Must provide name." while
// building QueriesPublic/HelloType - a throw inside beforeAll fails the hook itself, which Vitest
// reports as every test in the file being SKIPPED, not FAILED, and a skipped test still reads as
// Survived to Stryker. beforeEach runs inside the per-test window Stryker does track, so the same
// throw now fails each test individually. The repeated dynamic imports are cheap: Node's module
// cache resolves them from the first (real) evaluation, it does not re-run the module body.
let QueriesPublic: (typeof import('../src/graphQLPublic/schema/queries.mts'))['default']
let publicHelloArgs: (typeof import('../src/graphQLPublic/schema/queries/publicHelloArgs.mts'))['publicHelloArgs']
let publicHelloNoArgs: (typeof import('../src/graphQLPublic/schema/queries/publicHelloNoArgs.mts'))['publicHelloNoArgs']
let HelloType: (typeof import('../src/graphQLPublic/schema/types/HelloType.mts'))['default']

beforeEach(async () => {
	;({ default: QueriesPublic } = await import('../src/graphQLPublic/schema/queries.mts'))
	;({ publicHelloArgs } = await import('../src/graphQLPublic/schema/queries/publicHelloArgs.mts'))
	;({ publicHelloNoArgs } = await import('../src/graphQLPublic/schema/queries/publicHelloNoArgs.mts'))
	;({ default: HelloType } = await import('../src/graphQLPublic/schema/types/HelloType.mts'))
})

describe('HelloType', () => {
	it('exposes only the txt field, a non-nullable String', () => {
		const fields = HelloType.getFields()

		expect(HelloType.name).toBe('HelloType')
		expect(Object.keys(fields)).toEqual(['txt'])
		expect(fields.txt.type).toBeInstanceOf(GraphQLNonNull)
		expect((fields.txt.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})
})

describe('queries.publicHelloNoArgs', () => {
	it('is of non-nullable HelloType', () => {
		expect(publicHelloNoArgs.type).toBeInstanceOf(GraphQLNonNull)
		expect((publicHelloNoArgs.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(HelloType)
	})

	it('takes no arguments', () => {
		expect('args' in publicHelloNoArgs).toBe(false)
	})

	it('describes itself as publicHelloNoArgs', () => {
		expect(publicHelloNoArgs.description).toBe('publicHelloNoArgs')
	})

	it('resolves the greeting text', () => {
		expect(publicHelloNoArgs.resolve()).toEqual({ txt: 'Hello from publicHelloNoArgs' })
	})
})

describe('queries.publicHelloArgs', () => {
	it('is of non-nullable HelloType', () => {
		expect(publicHelloArgs.type).toBeInstanceOf(GraphQLNonNull)
		expect((publicHelloArgs.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(HelloType)
	})

	it('declares name as a non-nullable String argument', () => {
		expect(Object.keys(publicHelloArgs.args)).toEqual(['name'])
		expect(publicHelloArgs.args.name.type).toBeInstanceOf(GraphQLNonNull)
		expect((publicHelloArgs.args.name.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})

	it('describes itself as publicHelloArgs', () => {
		expect(publicHelloArgs.description).toBe('publicHelloArgs')
	})

	it('interpolates the name into the greeting', () => {
		expect(publicHelloArgs.resolve(null, { name: 'Mark' })).toEqual({
			txt: 'Hello from publicHelloArgs - Mark!'
		})
	})

	// E12-S20. The argument reached `console.debug` here and nowhere else in nine services, which is what
	// made it the one planted marker E12-S12 found on disk. The assertion is on the console object rather
	// than on one method: a later edit that reaches for `log` or `info` instead has changed nothing about
	// why this line exists.
	it('writes the caller-supplied name to no console method at all', () => {
		const spies = (['debug', 'log', 'info', 'warn', 'error'] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => undefined)
		)

		publicHelloArgs.resolve(null, { name: 'Mark' })

		for (const spy of spies) expect(spy).not.toHaveBeenCalled()

		vi.restoreAllMocks()
	})
})

describe('QueriesPublic', () => {
	// The full field list, in declaration order, and asserted exhaustively on purpose: this service has
	// no auth middleware, so every name below is reachable unauthenticated by anyone on the internet.
	// A `toContain` here would let a field be added to the public surface without a test changing.
	it('mounts the demo pair and the nine public reads as its only fields', () => {
		expect(QueriesPublic.name).toBe('QueriesPublic')
		expect(Object.keys(QueriesPublic.getFields())).toEqual([
			'publicHelloNoArgs',
			'publicHelloArgs',
			'companies',
			'companyBySlug',
			'companiesNearby',
			'items',
			'itemBySlug',
			'itemCategories',
			'searchCompanies',
			'searchItems',
			'sitemapEntries'
		])
	})

	it('runs the no-args query end-to-end', async () => {
		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesPublic }),
			source: '{ publicHelloNoArgs { txt } }'
		})

		expect(result.errors).toBeUndefined()
		expect(result.data).toEqual({ publicHelloNoArgs: { txt: 'Hello from publicHelloNoArgs' } })
	})

	it('runs the args query end-to-end', async () => {
		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesPublic }),
			source: '{ publicHelloArgs(name: "Luigi") { txt } }'
		})

		expect(result.errors).toBeUndefined()
		expect(result.data).toEqual({ publicHelloArgs: { txt: 'Hello from publicHelloArgs - Luigi!' } })
	})

	it('rejects the args query without the mandatory name', async () => {
		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesPublic }),
			source: '{ publicHelloArgs { txt } }'
		})

		expect(result.errors).toBeDefined()
		expect(result.errors?.[0].message).toMatch(/argument "name"/i)
	})
})
