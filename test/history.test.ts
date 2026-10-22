import { describe, expect, it } from 'vitest';
import { AppleApiError, clampHistoryStart, fetchNotificationHistory, signAppleJwt } from '../src/index';
import { base64UrlToBytes } from '../src/der';

const DAY = 24 * 60 * 60 * 1000;

async function testKey() {
	const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
	const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
	const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
	return { key: { issuerId: 'issuer-1', keyId: 'KEY123', privateKeyPem: pem }, publicKey: pair.publicKey };
}

function decode(segment: string) {
	return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

describe('signAppleJwt', () => {
	it('signs a token Web Crypto verifies, with the claims Apple expects', async () => {
		const { key, publicKey } = await testKey();
		const now = 1_760_000_000_000;
		const jwt = await signAppleJwt(key, { bundleId: 'io.example.app', now });
		const [h, p, s] = jwt.split('.');
		expect(decode(h)).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
		expect(decode(p)).toEqual({ iss: 'issuer-1', iat: now / 1000, exp: now / 1000 + 1200, aud: 'appstoreconnect-v1', bid: 'io.example.app' });
		const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, base64UrlToBytes(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
		expect(ok).toBe(true);
	});

	it('leaves out bid when no bundle id is given and caps the lifetime at 60 minutes', async () => {
		const { key } = await testKey();
		const payload = decode((await signAppleJwt(key, { expiresInSeconds: 99999, now: 0 })).split('.')[1]);
		expect(payload.bid).toBeUndefined();
		expect(payload.exp - payload.iat).toBe(3600);
	});
});

describe('fetchNotificationHistory', () => {
	it('follows pagination and yields every signedPayload in order', async () => {
		const { key } = await testKey();
		const calls: { url: string; body: unknown; auth: string | null }[] = [];
		const pages = [
			{ notificationHistory: [{ signedPayload: 'a' }, { signedPayload: 'b' }], hasMore: true, paginationToken: 'p2' },
			{ notificationHistory: [{ signedPayload: 'c' }], hasMore: false },
		];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('Authorization') });
			return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200 });
		}) as unknown as typeof fetch;

		const now = Date.now();
		const out: string[] = [];
		for await (const item of fetchNotificationHistory({ key, bundleId: 'io.example.app', environment: 'Production', startDate: now - 7 * DAY, now, fetch: fakeFetch })) {
			out.push(item.signedPayload);
		}
		expect(out).toEqual(['a', 'b', 'c']);
		expect(calls[0].url).toBe('https://api.storekit.itunes.apple.com/inApps/v1/notifications/history');
		expect(calls[1].url).toBe('https://api.storekit.itunes.apple.com/inApps/v1/notifications/history?paginationToken=p2');
		expect(calls[0].body).toEqual({ startDate: now - 7 * DAY, endDate: now });
		expect(calls[0].auth).toMatch(/^Bearer ey/);
	});

	it('uses the sandbox host for Sandbox', async () => {
		const { key } = await testKey();
		let seen = '';
		const fakeFetch = (async (url: string) => {
			seen = url;
			return new Response(JSON.stringify({ notificationHistory: [], hasMore: false }), { status: 200 });
		}) as unknown as typeof fetch;
		for await (const _ of fetchNotificationHistory({ key, bundleId: 'x', environment: 'Sandbox', startDate: Date.now() - DAY, fetch: fakeFetch })) void _;
		expect(seen).toBe('https://api.storekit-sandbox.itunes.apple.com/inApps/v1/notifications/history');
	});

	it('throws AppleApiError with Apple status and errorCode', async () => {
		const { key } = await testKey();
		const fakeFetch = (async () => new Response(JSON.stringify({ errorCode: 4040010, errorMessage: 'Invalid app identifier' }), { status: 404 })) as unknown as typeof fetch;
		const run = async () => {
			for await (const _ of fetchNotificationHistory({ key, bundleId: 'x', environment: 'Production', startDate: Date.now() - DAY, fetch: fakeFetch })) void _;
		};
		await expect(run()).rejects.toMatchObject({ name: 'AppleApiError', status: 404, errorCode: 4040010 });
		await expect(run()).rejects.toBeInstanceOf(AppleApiError);
	});
});

describe('clampHistoryStart', () => {
	it('moves a start older than 180 days and reports it', () => {
		const now = Date.now();
		expect(clampHistoryStart(now - 10 * DAY, now)).toEqual({ startDate: now - 10 * DAY, clamped: false });
		const clamped = clampHistoryStart(now - 400 * DAY, now);
		expect(clamped.clamped).toBe(true);
		expect(clamped.startDate).toBeGreaterThan(now - 180 * DAY);
	});

	it('uses Apple\'s 30-day window for Sandbox', () => {
		const now = Date.now();
		expect(clampHistoryStart(now - 60 * DAY, now, 'Sandbox').clamped).toBe(true);
		expect(clampHistoryStart(now - 60 * DAY, now, 'Sandbox').startDate).toBeGreaterThan(now - 30 * DAY);
		expect(clampHistoryStart(now - 20 * DAY, now, 'Sandbox').clamped).toBe(false);
	});
});
