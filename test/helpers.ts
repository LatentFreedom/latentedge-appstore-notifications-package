import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(__dirname, 'fixtures');

export function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

export function base64Url(input: Uint8Array | string): string {
	return Buffer.from(typeof input === 'string' ? new TextEncoder().encode(input) : input).toString('base64url');
}

export type ChainName = 'test' | 'other';

export const TEST_ROOT = fixture('test-root.der');

export function chain(name: ChainName): string[] {
	return [`${name}-leaf.der`, `${name}-intermediate.der`, `${name}-root.der`].map((file) => toBase64(fixture(file)));
}

async function leafKey(name: ChainName): Promise<CryptoKey> {
	const pem = readFileSync(join(FIXTURES, `${name}-leaf.pkcs8.pem`), 'utf8');
	const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
	return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Sign a payload the way Apple does: ES256 with the chain in x5c. */
export async function signJws(
	payload: unknown,
	options: { chain?: ChainName; signer?: ChainName; header?: Record<string, unknown> } = {}
): Promise<string> {
	const header = base64Url(JSON.stringify({ alg: 'ES256', x5c: chain(options.chain ?? 'test'), ...options.header }));
	const body = base64Url(JSON.stringify(payload));
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		await leafKey(options.signer ?? options.chain ?? 'test'),
		new TextEncoder().encode(`${header}.${body}`)
	);
	return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}

export function sampleTransaction(overrides: Record<string, unknown> = {}) {
	return {
		transactionId: '2000000123456789',
		originalTransactionId: '2000000123456789',
		bundleId: 'io.example.app',
		productId: 'io.example.app.lifetime',
		type: 'Non-Consumable',
		purchaseDate: Date.now(),
		signedDate: Date.now(),
		environment: 'Production',
		storefront: 'USA',
		currency: 'USD',
		price: 4990,
		transactionReason: 'PURCHASE',
		...overrides,
	};
}

export async function sampleNotification(
	overrides: Record<string, unknown> = {},
	transaction: Record<string, unknown> | null = sampleTransaction()
) {
	return {
		notificationType: 'ONE_TIME_CHARGE',
		notificationUUID: 'a1b2c3d4-0000-4000-8000-000000000001',
		version: '2.0',
		signedDate: Date.now(),
		data: {
			appAppleId: 1234567890,
			bundleId: 'io.example.app',
			environment: 'Production',
			...(transaction ? { signedTransactionInfo: await signJws(transaction) } : {}),
		},
		...overrides,
	};
}

/** In-memory stand-in for the one D1 statement the package runs. */
export function fakeDb() {
	const rows = new Map<string, unknown[]>();
	return {
		rows,
		prepare(sql: string) {
			return {
				bind(...values: unknown[]) {
					return {
						async run() {
							if (!sql.startsWith('INSERT OR IGNORE INTO appstore_events')) throw new Error(`Unexpected SQL: ${sql}`);
							const key = values[0] as string;
							if (rows.has(key)) return { meta: { changes: 0 } };
							rows.set(key, values);
							return { meta: { changes: 1 } };
						},
					};
				},
			};
		},
	};
}
