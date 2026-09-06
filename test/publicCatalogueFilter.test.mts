import { readdir, readFile } from 'node:fs/promises'

import { parse } from '@typescript-eslint/parser'
import { describe, expect, it } from 'vitest'

/*
 * Every function in this service that reads `company` or `item` composes the shared liveness filter.
 *
 * `livePublic()` and `LIVE_PUBLIC_PIPELINE` (src/lib/catalogue/publicRead.mts) are the two spellings of
 * `{ published: true, deleted: <absent> }`, and they are the only thing between an anonymous visitor and
 * a shop owner's unpublished drafts. Composing them is a habit, and a habit is what a copy-pasted
 * resolver drops silently — RISK_REGISTER R18. `test/schema.test.mts` already refuses a *field* nobody
 * added to its list; nothing looked inside the resolver the field points at, so a new query could be
 * declared, listed, reviewed and shipped while serving drafts.
 *
 * The check is syntactic and per-enclosing-function: for every `Company.<read>()` / `Item.<read>()` call
 * in `src/`, the function containing it must name `livePublic` or `LIVE_PUBLIC_PIPELINE` somewhere in
 * its own body. Per-function rather than per-file on purpose — a second resolver pasted into a file that
 * already imports the filter would pass a per-file grep while composing nothing.
 *
 * ⚠️ Deliberately NOT the two cross-cutting helpers. `liveCompanyBySlug` and `liveItemsAcrossShops` bake
 * the filter in themselves, and admitting their names here would let a function satisfy the rule by
 * being one of them — a check that a definition references its own name proves nothing. Both files pass
 * on the strict rule as written, so the loophole buys nothing and is not opened.
 *
 * Text matching is not used anywhere below. `Company.aggregate<IPin>(` is this codebase's own idiom at
 * every aggregation call site, and a type argument between the method name and its parenthesis defeats
 * a `\.aggregate\(` regex while changing nothing about the call. The parser sees the CallExpression
 * either way.
 */

const SRC = new URL('../src/', import.meta.url)

/** The two models an anonymous caller must never see an unpublished row of. */
const MODELS = new Set(['Company', 'Item'])

/** Mongoose reads that return documents to a caller. A write is a different risk and a different row. */
const READ_METHODS = new Set(['aggregate', 'countDocuments', 'distinct', 'exists', 'find', 'findById', 'findOne'])

/** The shared filter, in its two spellings. Nothing else counts — see the ⚠️ above. */
const SAFE_NAMES = new Set(['livePublic', 'LIVE_PUBLIC_PIPELINE'])

/**
 * Every file that is allowed to read `company` or `item` at all.
 *
 * Exhaustive, the same way `test/schema.test.mts` lists the public schema's fields exhaustively: a new
 * file that reads either model fails this list until somebody puts it there on purpose, which is the
 * review this row asks for. Nine entries, seven resolvers and the two cross-cutting helpers.
 */
const FILES_THAT_READ_THE_CATALOGUE = [
	'graphQLPublic/schema/queries/companies.mts',
	'graphQLPublic/schema/queries/companiesNearby.mts',
	'graphQLPublic/schema/queries/companyBySlug.mts',
	'graphQLPublic/schema/queries/itemBySlug.mts',
	'graphQLPublic/schema/queries/items.mts',
	'graphQLPublic/schema/queries/search.mts',
	'graphQLPublic/schema/queries/sitemapEntries.mts',
	'lib/catalogue/liveCompanyBySlug.mts',
	'lib/catalogue/liveItemsAcrossShops.mts'
]

const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])

type Node = Record<string, unknown> & { type: string }

/**
 * Depth-first over an ESTree tree, carrying the nearest enclosing function down with it.
 *
 * The enclosing function is threaded through the recursion rather than read off a `parent` pointer,
 * because `parse()` without `project` does not set one and asking for one would drag the whole
 * type-aware program in for a check that needs no types.
 */
function walk(value: unknown, visit: (node: Node, enclosing: Node | undefined) => void, enclosing?: Node): void {
	if (Array.isArray(value)) {
		for (const entry of value) walk(entry, visit, enclosing)
		return
	}

	if (value === null || typeof value !== 'object') return

	const node = value as Node
	if (typeof node.type !== 'string') return

	const scope = FUNCTION_TYPES.has(node.type) ? node : enclosing
	visit(node, scope)

	for (const key of Object.keys(node)) {
		if (key === 'parent') continue
		walk(node[key], visit, scope)
	}
}

/** True when `node`'s subtree names the shared filter — the whole of what this check asserts. */
export function referencesSharedFilter(node: unknown): boolean {
	let found = false

	walk(node, (current) => {
		if (current.type === 'Identifier' && SAFE_NAMES.has(current.name as string)) found = true
	})

	return found
}

/** `<file>:<line>` for every catalogue read whose enclosing function never names the shared filter. */
export function unfilteredCatalogueReads(source: string, label: string): string[] {
	const ast = parse(source, { loc: true, sourceType: 'module' }) as unknown as Node
	const violations: string[] = []

	walk(ast, (node, enclosing) => {
		if (node.type !== 'CallExpression') return

		const callee = node.callee as Node | undefined
		if (callee?.type !== 'MemberExpression') return

		const object = callee.object as Node | undefined
		const property = callee.property as Node | undefined
		if (object?.type !== 'Identifier' || !MODELS.has(object.name as string)) return
		if (property?.type !== 'Identifier' || !READ_METHODS.has(property.name as string)) return

		// No enclosing function means the read runs at module scope, which no resolver does and which
		// this rule has no way to vouch for. Falling back to the whole file would let a top-level
		// `livePublic` import excuse it, so the read is reported instead.
		if (enclosing === undefined || !referencesSharedFilter(enclosing)) {
			const line = (node.loc as { start: { line: number } }).start.line
			violations.push(`${label}:${line}`)
		}
	})

	return violations
}

/** Every `.mts` under `src/`, path relative to `src/`, so the assertions read as source paths. */
async function sourceFiles(directory = ''): Promise<string[]> {
	const entries = await readdir(new URL(directory, SRC), { withFileTypes: true })
	const found: string[] = []

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) found.push(...(await sourceFiles(`${directory}${entry.name}/`)))
		else if (entry.name.endsWith('.mts')) found.push(`${directory}${entry.name}`)
	}

	return found
}

const FIXTURES = new URL('./fixtures/publicCatalogueFilter/', import.meta.url)

const readFixture = async (name: string) => readFile(new URL(`${name}.mts.fixture`, FIXTURES), 'utf8')

describe('the files that read the public catalogue are the files that are meant to', () => {
	it('finds a Company or Item read in exactly the listed files', async () => {
		const reading: string[] = []

		for (const file of await sourceFiles()) {
			const ast = parse(await readFile(new URL(file, SRC), 'utf8'), { sourceType: 'module' }) as unknown as Node
			let reads = false

			walk(ast, (node) => {
				if (node.type !== 'CallExpression') return

				const callee = node.callee as Node | undefined
				if (callee?.type !== 'MemberExpression') return

				const object = callee.object as Node | undefined
				const property = callee.property as Node | undefined
				if (object?.type === 'Identifier' && MODELS.has(object.name as string)) {
					if (property?.type === 'Identifier' && READ_METHODS.has(property.name as string)) reads = true
				}
			})

			if (reads) reading.push(file)
		}

		expect(reading).toStrictEqual(FILES_THAT_READ_THE_CATALOGUE)
	})
})

describe('every catalogue read composes the shared liveness filter', () => {
	it('reports no unfiltered read anywhere under src/', async () => {
		const violations: string[] = []

		for (const file of FILES_THAT_READ_THE_CATALOGUE) {
			violations.push(...unfilteredCatalogueReads(await readFile(new URL(file, SRC), 'utf8'), file))
		}

		expect(violations).toStrictEqual([])
	})
})

/*
 * The half that makes the half above mean something.
 *
 * A check that has only ever reported zero is indistinguishable from a check that cannot report
 * anything else. These two fixtures are the same resolver with and without the filter, fed through the
 * same function the real files go through, and they are `.mts.fixture` rather than `.mts` so `yarn lint`
 * does not try to type-check a file whose whole purpose is to be wrong.
 */
describe('the check can fail, not only pass', () => {
	it('reports the read in a resolver that omits the filter', async () => {
		expect(unfilteredCatalogueReads(await readFixture('omitsFilter'), 'omitsFilter')).toStrictEqual(['omitsFilter:8'])
	})

	it('reports nothing on the same resolver once it composes the filter', async () => {
		expect(unfilteredCatalogueReads(await readFixture('composesFilter'), 'composesFilter')).toStrictEqual([])
	})

	it('reports a read at module scope, where no enclosing function can vouch for it', async () => {
		expect(unfilteredCatalogueReads(await readFixture('moduleScope'), 'moduleScope')).toStrictEqual(['moduleScope:5'])
	})

	it('reports a second resolver pasted into a file that already composes the filter elsewhere', async () => {
		expect(unfilteredCatalogueReads(await readFixture('secondResolver'), 'secondResolver')).toStrictEqual(['secondResolver:12'])
	})

	it('sees through the generic type argument every aggregation here is written with', async () => {
		expect(unfilteredCatalogueReads(await readFixture('genericAggregate'), 'genericAggregate')).toStrictEqual([
			'genericAggregate:8'
		])
	})

	it('says nothing about a name that is neither Company nor Item', async () => {
		expect(unfilteredCatalogueReads(await readFixture('otherModel'), 'otherModel')).toStrictEqual([])
	})

	it('holds no opinion about a subtree with no identifier in it', () => {
		expect(referencesSharedFilter(null)).toBe(false)
		expect(referencesSharedFilter([{ type: 'Literal', value: 1 }])).toBe(false)
	})
})
