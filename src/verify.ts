import { base64ToBytes, base64UrlToBytes, bytesEqual } from './der';
import { APPLE_ROOT_CA_G3 } from './roots';
import { VerificationError } from './types';
import { Certificate, importPublicKey, isSignedBy, parseCertificate } from './x509';

/** Apple marks its App Store signing leaf and WWDR intermediate with these extensions. */
const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

export interface VerifyOptions {
	/**
	 * DER root certificates the chain may end at. Defaults to Apple Root CA - G3.
	 * Override only in tests.
	 */
	trustedRoots?: Uint8Array[];
	/**
	 * The time certificates must be valid at, in epoch ms. Defaults to the
	 * payload's signedDate, as Apple's own libraries do, so a notification
	 * Apple signed while its certificates were valid stays verifiable later.
	 */
	effectiveDate?: number;
}

function parseJson(bytes: Uint8Array, what: string): Record<string, unknown> {
	try {
		const value = JSON.parse(new TextDecoder().decode(bytes));
		if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// fall through to the shared error
	}
	throw new VerificationError(`Malformed JWS ${what}`);
}

function parseChainCert(base64: unknown, position: string): Certificate {
	if (typeof base64 !== 'string') throw new VerificationError(`x5c ${position} is not a string`);
	try {
		return parseCertificate(base64ToBytes(base64));
	} catch {
		throw new VerificationError(`x5c ${position} is not a valid certificate`);
	}
}

/**
 * Verify an Apple-signed JWS (a notification signedPayload, a
 * signedTransactionInfo, or a signedRenewalInfo) and return its payload.
 *
 * Checks, in order: ES256 header with a three-certificate x5c chain, the
 * chain root is byte-identical to a trusted root, Apple's marker extensions
 * on the leaf and intermediate, the intermediate is a CA, every certificate
 * is valid at the effective date, each link is signed by the next, and the
 * JWS signature verifies against the leaf key. Any failure throws
 * VerificationError; nothing is returned from an unverified token.
 */
export async function verifyJws<T>(jws: string, options: VerifyOptions = {}): Promise<T> {
	if (typeof jws !== 'string') throw new VerificationError('JWS is not a string');
	const segments = jws.split('.');
	if (segments.length !== 3) throw new VerificationError('JWS must have three segments');

	let headerBytes: Uint8Array;
	let payloadBytes: Uint8Array;
	let signature: Uint8Array;
	try {
		headerBytes = base64UrlToBytes(segments[0]);
		payloadBytes = base64UrlToBytes(segments[1]);
		signature = base64UrlToBytes(segments[2]);
	} catch {
		throw new VerificationError('JWS segment is not base64url');
	}

	const header = parseJson(headerBytes, 'header');
	if (header.alg !== 'ES256') throw new VerificationError('JWS alg must be ES256');
	const x5c = header.x5c;
	if (!Array.isArray(x5c) || x5c.length !== 3) throw new VerificationError('x5c must hold leaf, intermediate, and root');

	const leaf = parseChainCert(x5c[0], 'leaf');
	const intermediate = parseChainCert(x5c[1], 'intermediate');
	const root = parseChainCert(x5c[2], 'root');

	const trustedRoots = options.trustedRoots ?? [APPLE_ROOT_CA_G3];
	if (!trustedRoots.some((trusted) => bytesEqual(trusted, root.der))) {
		throw new VerificationError('Chain does not end at a trusted root');
	}
	if (!leaf.extensionOids.has(APPLE_LEAF_OID)) throw new VerificationError('Leaf is not an App Store signing certificate');
	if (!intermediate.extensionOids.has(APPLE_INTERMEDIATE_OID)) throw new VerificationError('Intermediate is not an Apple WWDR certificate');
	if (!intermediate.isCa || !root.isCa) throw new VerificationError('Issuing certificate is not a CA');
	if (leaf.curve.name !== 'P-256') throw new VerificationError('ES256 needs a P-256 leaf key');

	const payload = parseJson(payloadBytes, 'payload');
	const effectiveDate =
		options.effectiveDate ?? (typeof payload.signedDate === 'number' ? payload.signedDate : Date.now());
	for (const [cert, name] of [
		[leaf, 'Leaf'],
		[intermediate, 'Intermediate'],
		[root, 'Root'],
	] as const) {
		if (effectiveDate < cert.notBefore || effectiveDate > cert.notAfter) {
			throw new VerificationError(`${name} certificate is not valid at the signing date`);
		}
	}

	if (!(await isSignedBy(leaf, intermediate))) throw new VerificationError('Leaf is not signed by the intermediate');
	if (!(await isSignedBy(intermediate, root))) throw new VerificationError('Intermediate is not signed by the root');

	// JWS ES256 signatures are already raw r||s, which is what Web Crypto expects.
	if (signature.length !== 64) throw new VerificationError('ES256 signature must be 64 bytes');
	const signingInput = new TextEncoder().encode(`${segments[0]}.${segments[1]}`);
	const valid = await crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		await importPublicKey(leaf),
		signature as BufferSource,
		signingInput
	);
	if (!valid) throw new VerificationError('JWS signature does not verify');

	return payload as T;
}
