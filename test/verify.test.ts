import { describe, expect, it } from 'vitest';
import { APPLE_ROOT_CA_G3, VerificationError, eventKindFor, recordEvent, verifyJws, verifyNotification } from '../src/index';
import { isSignedBy, parseCertificate } from '../src/x509';
import { TEST_ROOT, base64Url, chain, fakeDb, sampleNotification, sampleTransaction, signJws } from './helpers';

const trustTest = { trustedRoots: [TEST_ROOT] };

describe('pinned Apple root', () => {
	it('parses as a self-signed P-384 CA valid until 2039', async () => {
		const root = parseCertificate(APPLE_ROOT_CA_G3);
		expect(root.isCa).toBe(true);
		expect(root.curve.name).toBe('P-384');
		expect(new Date(root.notAfter).toISOString()).toBe('2039-04-30T18:19:06.000Z');
		expect(await isSignedBy(root, root)).toBe(true);
	});

	it('is the default trust anchor, so a test chain is rejected without an override', async () => {
		const jws = await signJws(sampleTransaction());
		await expect(verifyJws(jws)).rejects.toThrow('Chain does not end at a trusted root');
	});
});

describe('verifyJws', () => {
	it('returns the payload of a correctly signed chain', async () => {
		const tx = sampleTransaction();
		await expect(verifyJws(await signJws(tx), trustTest)).resolves.toEqual(tx);
	});

	it('rejects a payload with one changed byte', async () => {
		const [header, body, sig] = (await signJws(sampleTransaction())).split('.');
		const tampered = base64Url(JSON.stringify({ ...sampleTransaction(), price: 1 }));
		expect(tampered).not.toBe(body);
		await expect(verifyJws(`${header}.${tampered}.${sig}`, trustTest)).rejects.toThrow('JWS signature does not verify');
	});

	it('rejects a chain from a different root', async () => {
		const jws = await signJws(sampleTransaction(), { chain: 'other' });
		await expect(verifyJws(jws, trustTest)).rejects.toThrow('Chain does not end at a trusted root');
	});

	it('rejects the trusted root spliced onto another chain', async () => {
		const [otherLeaf, otherIntermediate] = chain('other');
		const [, , testRoot] = chain('test');
		const jws = await signJws(sampleTransaction(), { signer: 'other', header: { x5c: [otherLeaf, otherIntermediate, testRoot] } });
		await expect(verifyJws(jws, trustTest)).rejects.toThrow('Intermediate is not signed by the root');
	});

	it('rejects a leaf used outside its validity window', async () => {
		const jws = await signJws(sampleTransaction({ signedDate: Date.now() + 20 * 365 * 24 * 3600 * 1000 }));
		await expect(verifyJws(jws, trustTest)).rejects.toThrow('Leaf certificate is not valid at the signing date');
	});

	it('rejects a signature made by a key outside the chain', async () => {
		const jws = await signJws(sampleTransaction(), { signer: 'other' });
		await expect(verifyJws(jws, trustTest)).rejects.toThrow('JWS signature does not verify');
	});

	it('rejects alg none and short chains', async () => {
		await expect(verifyJws(await signJws({}, { header: { alg: 'none' } }), trustTest)).rejects.toThrow('ES256');
		await expect(verifyJws(await signJws({}, { header: { x5c: chain('test').slice(0, 2) } }), trustTest)).rejects.toThrow('x5c');
	});

	it('rejects malformed input with VerificationError', async () => {
		for (const bad of ['', 'a.b', 'a.b.c', '!!.@@.##']) {
			await expect(verifyJws(bad, trustTest)).rejects.toBeInstanceOf(VerificationError);
		}
	});
});

describe('verifyNotification', () => {
	it('verifies the outer payload and the nested transaction', async () => {
		const body = { signedPayload: await signJws(await sampleNotification()) };
		const verified = await verifyNotification(body, trustTest);
		expect(verified.eventKind).toBe('purchase');
		expect(verified.transaction?.price).toBe(4990);
		expect(verified.transaction?.currency).toBe('USD');
	});

	it('rejects a nested transaction from another app', async () => {
		const notification = await sampleNotification({}, sampleTransaction({ bundleId: 'io.other.app' }));
		await expect(verifyNotification({ signedPayload: await signJws(notification) }, trustTest)).rejects.toThrow('bundleId');
	});

	it('rejects a nested transaction with a bad signature', async () => {
		const notification = await sampleNotification({}, null);
		(notification.data as Record<string, unknown>).signedTransactionInfo = await signJws(sampleTransaction(), { signer: 'other' });
		await expect(verifyNotification({ signedPayload: await signJws(notification) }, trustTest)).rejects.toThrow('signature');
	});

	it('accepts a TEST notification with no transaction', async () => {
		const notification = await sampleNotification({ notificationType: 'TEST' }, null);
		const verified = await verifyNotification(await signJws(notification), trustTest);
		expect(verified.eventKind).toBe('test');
		expect(verified.transaction).toBeNull();
	});

	it('rejects a body with no signedPayload', async () => {
		await expect(verifyNotification({}, trustTest)).rejects.toThrow('Missing signedPayload');
	});
});

describe('verifyNotification cross-checks the signed parts', () => {
	function renewal(overrides: Record<string, unknown> = {}) {
		return { originalTransactionId: '2000000123456789', autoRenewStatus: 1, signedDate: Date.now(), environment: 'Production', ...overrides };
	}

	async function withRenewal(info: Record<string, unknown>, tx = sampleTransaction()) {
		const notification = await sampleNotification({ notificationType: 'DID_RENEW' }, tx);
		(notification.data as Record<string, unknown>).signedRenewalInfo = await signJws(info);
		return signJws(notification);
	}

	it('accepts a matching transaction and renewal info', async () => {
		const verified = await verifyNotification(await withRenewal(renewal()), trustTest);
		expect(verified.renewalInfo?.originalTransactionId).toBe('2000000123456789');
	});

	it('rejects renewal info from another subscription', async () => {
		await expect(verifyNotification(await withRenewal(renewal({ originalTransactionId: '9' })), trustTest)).rejects.toThrow(
			'Renewal info originalTransactionId'
		);
	});

	it('rejects renewal info from another environment', async () => {
		await expect(verifyNotification(await withRenewal(renewal({ environment: 'Sandbox' })), trustTest)).rejects.toThrow(
			'Renewal info environment'
		);
	});

	it('rejects a Sandbox transaction inside a Production notification', async () => {
		const notification = await sampleNotification({}, sampleTransaction({ environment: 'Sandbox' }));
		await expect(verifyNotification(await signJws(notification), trustTest)).rejects.toThrow('Transaction environment');
	});
});

describe('verifyNotification with expected apps', () => {
	const ours = { ...trustTest, apps: [{ bundleId: 'io.example.app', appAppleId: 1234567890 }], environments: ['Production' as const] };

	it('accepts a notification for an expected app and environment', async () => {
		const verified = await verifyNotification(await signJws(await sampleNotification()), ours);
		expect(verified.eventKind).toBe('purchase');
	});

	it('rejects a real notification for an app this endpoint does not serve', async () => {
		const notification = await sampleNotification(
			{ data: { bundleId: 'io.stranger.app', appAppleId: 999, environment: 'Production' } },
			null
		);
		await expect(verifyNotification(await signJws(notification), ours)).rejects.toThrow('unexpected app (io.stranger.app)');
	});

	it('rejects a Sandbox notification on a Production-only endpoint', async () => {
		const notification = await sampleNotification({ data: { bundleId: 'io.example.app', environment: 'Sandbox' } }, null);
		await expect(verifyNotification(await signJws(notification), ours)).rejects.toThrow('environment Sandbox is not accepted');
	});

	it('rejects a wrong appAppleId, and a missing one in Production', async () => {
		const wrong = await sampleNotification({ data: { bundleId: 'io.example.app', appAppleId: 1, environment: 'Production' } }, null);
		await expect(verifyNotification(await signJws(wrong), ours)).rejects.toThrow('appAppleId');
		const missing = await sampleNotification({ data: { bundleId: 'io.example.app', environment: 'Production' } }, null);
		await expect(verifyNotification(await signJws(missing), ours)).rejects.toThrow('appAppleId');
	});

	it('accepts a Sandbox notification without appAppleId when Sandbox is allowed', async () => {
		const notification = await sampleNotification({ data: { bundleId: 'io.example.app', environment: 'Sandbox' } }, null);
		const options = { ...ours, environments: ['Sandbox' as const, 'Production' as const] };
		await expect(verifyNotification(await signJws(notification), options)).resolves.toBeTruthy();
	});

	it('reads the app from a summary notification', async () => {
		const notification = await sampleNotification(
			{ notificationType: 'RENEWAL_EXTENSION', data: undefined, summary: { bundleId: 'io.example.app', appAppleId: 1234567890, environment: 'Production' } },
			null
		);
		const verified = await verifyNotification(await signJws(notification), ours);
		expect((await recordEvent(fakeDb(), verified)).row).toMatchObject({ bundle_id: 'io.example.app', environment: 'Production' });
	});

	it('reads the environment of an external purchase token from its id prefix', async () => {
		const notification = await sampleNotification(
			{
				notificationType: 'EXTERNAL_PURCHASE_TOKEN',
				data: undefined,
				externalPurchaseToken: { externalPurchaseId: 'SANDBOX_abc', bundleId: 'io.example.app', appAppleId: 1234567890 },
			},
			null
		);
		await expect(verifyNotification(await signJws(notification), ours)).rejects.toThrow('environment Sandbox');
	});
});

describe('eventKindFor', () => {
	it('maps sales types and falls back to other', () => {
		expect(eventKindFor('DID_RENEW')).toBe('renewal');
		expect(eventKindFor('REFUND')).toBe('refund');
		expect(eventKindFor('DID_CHANGE_RENEWAL_PREF')).toBe('other');
	});

	it('reads the subtype where it decides whether money moved', () => {
		expect(eventKindFor('DID_CHANGE_RENEWAL_PREF', 'UPGRADE')).toBe('purchase');
		expect(eventKindFor('DID_CHANGE_RENEWAL_PREF', 'DOWNGRADE')).toBe('other');
		expect(eventKindFor('OFFER_REDEEMED', 'UPGRADE')).toBe('purchase');
		expect(eventKindFor('OFFER_REDEEMED', 'DOWNGRADE')).toBe('other');
		expect(eventKindFor('OFFER_REDEEMED')).toBe('other');
		expect(eventKindFor('SUBSCRIBED', 'RESUBSCRIBE')).toBe('purchase');
		expect(eventKindFor('DID_RENEW', 'BILLING_RECOVERY')).toBe('renewal');
	});

	it('uses the subtype when verifying', async () => {
		const notification = await sampleNotification({ notificationType: 'DID_CHANGE_RENEWAL_PREF', subtype: 'UPGRADE' });
		expect((await verifyNotification(await signJws(notification), trustTest)).eventKind).toBe('purchase');
	});
});

describe('recordEvent', () => {
	it('stores one row per notificationUUID', async () => {
		const verified = await verifyNotification(await signJws(await sampleNotification()), trustTest);
		const db = fakeDb();
		expect((await recordEvent(db, verified)).inserted).toBe(true);
		expect((await recordEvent(db, verified)).inserted).toBe(false);
		expect(db.rows.size).toBe(1);
		const { row } = await recordEvent(db, verified);
		expect(row).toMatchObject({
			bundle_id: 'io.example.app',
			event_kind: 'purchase',
			price_milliunits: 4990,
			environment: 'Production',
			product_type: 'Non-Consumable',
			transaction_reason: 'PURCHASE',
			expires_date: null,
		});
		expect(row.purchase_date).toBeTypeOf('number');
		expect(row.signed_payload).toBe(verified.signedPayload);
	});

	it('stores null price and currency for payloads without pricing', async () => {
		const tx = sampleTransaction({ price: undefined, currency: undefined });
		const verified = await verifyNotification(await signJws(await sampleNotification({}, tx)), trustTest);
		const { row } = await recordEvent(fakeDb(), verified);
		expect(row.price_milliunits).toBeNull();
		expect(row.currency).toBeNull();
	});
});
