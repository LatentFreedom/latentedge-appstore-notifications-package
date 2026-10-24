import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1Like, recordEvent, verifyNotification } from '../src/index';
import { TEST_ROOT, sampleNotification, signJws } from './helpers';

// Vite 5 does not know node:sqlite as a builtin and rewrites the import, so load it at runtime.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

const MIGRATIONS = join(__dirname, '..', 'migrations');
const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort();

function apply(db: DatabaseSync, file: string) {
	db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
}

/** D1's prepare/bind/run over SQLite, so the real insert runs against the real schema. */
function asD1(db: DatabaseSync): D1Like {
	return {
		prepare(sql) {
			return {
				bind(...values) {
					return {
						async run() {
							const result = db.prepare(sql).run(...(values as (string | number | null)[]));
							return { meta: { changes: Number(result.changes) } };
						},
					};
				},
			};
		},
	};
}

describe('migrations', () => {
	it('give recordEvent every column it writes', async () => {
		const db = new DatabaseSync(':memory:');
		for (const file of files) apply(db, file);
		const verified = await verifyNotification(await signJws(await sampleNotification()), { trustedRoots: [TEST_ROOT] });
		expect((await recordEvent(asD1(db), verified)).inserted).toBe(true);
		expect((await recordEvent(asD1(db), verified)).inserted).toBe(false);
		const row = db.prepare('SELECT * FROM appstore_events').get() as Record<string, unknown>;
		expect(row).toMatchObject({ bundle_id: 'io.example.app', product_type: 'Non-Consumable', transaction_reason: 'PURCHASE' });
		expect(row.signed_payload).toBe(verified.signedPayload);
	});
});
