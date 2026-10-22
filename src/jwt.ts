import { base64ToBytes } from './der';

export interface AppleApiKey {
	/** Issuer ID from App Store Connect > Users and Access > Integrations. */
	issuerId: string;
	/** The key's ID (the kid header). */
	keyId: string;
	/** Contents of the .p8 file Apple gives you once: a PKCS#8 PEM. */
	privateKeyPem: string;
}

function base64Url(input: Uint8Array | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): Uint8Array {
	const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
	if (!body) throw new Error('privateKeyPem is empty');
	return base64ToBytes(body);
}

/**
 * Sign the ES256 bearer token Apple's APIs expect.
 *
 * The App Store Server API needs an In-App Purchase key and the app's
 * `bundleId` (the `bid` claim). The App Store Connect API (sales reports,
 * apps) needs a team API key and no `bid`. Apple rejects tokens that live
 * over 60 minutes; 20 is the default so one token covers a long paging run.
 */
export async function signAppleJwt(
	key: AppleApiKey,
	options: { bundleId?: string; expiresInSeconds?: number; now?: number } = {}
): Promise<string> {
	const iat = Math.floor((options.now ?? Date.now()) / 1000);
	const header = { alg: 'ES256', kid: key.keyId, typ: 'JWT' };
	const payload: Record<string, unknown> = {
		iss: key.issuerId,
		iat,
		exp: iat + Math.min(options.expiresInSeconds ?? 1200, 3600),
		aud: 'appstoreconnect-v1',
	};
	if (options.bundleId) payload.bid = options.bundleId;

	const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
	const privateKey = await crypto.subtle.importKey(
		'pkcs8',
		pemToPkcs8(key.privateKeyPem) as BufferSource,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
	// Web Crypto returns ECDSA signatures as raw r||s, which is the JWS form.
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(signingInput));
	return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
