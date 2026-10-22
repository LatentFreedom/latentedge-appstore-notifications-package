/**
 * Minimal DER reader for the parts of an X.509 certificate this package
 * needs. A full ASN.1 library would be a supply-chain dependency on the
 * signature path; the certificate shape is fixed, so a small reader is
 * easier to audit.
 */

export interface DerNode {
	tag: number;
	/** The whole TLV, header included. Signatures cover these exact bytes. */
	raw: Uint8Array;
	/** The value bytes only. */
	value: Uint8Array;
}

export class DerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DerError';
	}
}

export const TAG = {
	BOOLEAN: 0x01,
	INTEGER: 0x02,
	BIT_STRING: 0x03,
	OCTET_STRING: 0x04,
	OID: 0x06,
	UTC_TIME: 0x17,
	GENERALIZED_TIME: 0x18,
	SEQUENCE: 0x30,
	CONTEXT_0: 0xa0,
	CONTEXT_3: 0xa3,
} as const;

/** Read one TLV starting at `offset`. Returns the node and the next offset. */
export function readNode(bytes: Uint8Array, offset = 0): { node: DerNode; next: number } {
	if (offset + 2 > bytes.length) throw new DerError('Truncated DER header');
	const tag = bytes[offset];
	// High-tag-number form never appears in X.509 certificates.
	if ((tag & 0x1f) === 0x1f) throw new DerError('Unsupported high tag number');
	let length = bytes[offset + 1];
	let headerLength = 2;
	if (length & 0x80) {
		const count = length & 0x7f;
		// Indefinite length (0x80) is BER, not DER; over 4 bytes is not a real certificate.
		if (count === 0 || count > 4) throw new DerError('Unsupported DER length');
		if (offset + 2 + count > bytes.length) throw new DerError('Truncated DER length');
		length = 0;
		for (let i = 0; i < count; i++) {
			length = length * 256 + bytes[offset + 2 + i];
		}
		headerLength += count;
	}
	const start = offset + headerLength;
	const end = start + length;
	if (end > bytes.length) throw new DerError('DER value runs past the end of input');
	return {
		node: { tag, raw: bytes.subarray(offset, end), value: bytes.subarray(start, end) },
		next: end,
	};
}

/** Read every direct child of a constructed node. */
export function children(node: DerNode): DerNode[] {
	const out: DerNode[] = [];
	let offset = 0;
	while (offset < node.value.length) {
		const { node: child, next } = readNode(node.value, offset);
		out.push(child);
		offset = next;
	}
	return out;
}

export function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
	if (!node || node.tag !== tag) throw new DerError(`Expected ${what}`);
	return node;
}

/** Decode an OBJECT IDENTIFIER value to dotted form. */
export function decodeOid(value: Uint8Array): string {
	if (value.length === 0) throw new DerError('Empty OID');
	const parts: number[] = [];
	const first = value[0];
	parts.push(first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80);
	let current = 0;
	for (let i = 1; i < value.length; i++) {
		current = current * 128 + (value[i] & 0x7f);
		if (!(value[i] & 0x80)) {
			parts.push(current);
			current = 0;
		}
	}
	return parts.join('.');
}

/** Decode UTCTime or GeneralizedTime (always UTC with a trailing Z in X.509) to epoch ms. */
export function decodeTime(node: DerNode): number {
	const text = new TextDecoder().decode(node.value);
	let match: RegExpMatchArray | null;
	let year: number;
	if (node.tag === TAG.UTC_TIME) {
		match = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
		if (!match) throw new DerError('Bad UTCTime');
		const yy = Number(match[1]);
		// RFC 5280: two-digit years 50-99 are 19xx, 00-49 are 20xx.
		year = yy >= 50 ? 1900 + yy : 2000 + yy;
	} else if (node.tag === TAG.GENERALIZED_TIME) {
		match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
		if (!match) throw new DerError('Bad GeneralizedTime');
		year = Number(match[1]);
	} else {
		throw new DerError('Expected a time');
	}
	return Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

/** Strip the sign-padding zero DER adds to a positive INTEGER and left-pad to `size` bytes. */
function integerToFixed(value: Uint8Array, size: number): Uint8Array {
	let start = 0;
	while (start < value.length - 1 && value[start] === 0) start++;
	const trimmed = value.subarray(start);
	if (trimmed.length > size) throw new DerError('ECDSA integer too large for curve');
	const out = new Uint8Array(size);
	out.set(trimmed, size - trimmed.length);
	return out;
}

/**
 * X.509 stores ECDSA signatures as DER SEQUENCE { r, s }; Web Crypto wants the
 * raw r||s form, each half the curve's byte length.
 */
export function ecdsaDerToRaw(der: Uint8Array, size: number): Uint8Array {
	const { node, next } = readNode(der);
	if (next !== der.length) throw new DerError('Trailing bytes after ECDSA signature');
	const [r, s, extra] = children(expectTag(node, TAG.SEQUENCE, 'ECDSA signature sequence'));
	if (extra) throw new DerError('Extra fields in ECDSA signature');
	const out = new Uint8Array(size * 2);
	out.set(integerToFixed(expectTag(r, TAG.INTEGER, 'r').value, size), 0);
	out.set(integerToFixed(expectTag(s, TAG.INTEGER, 's').value, size), size);
	return out;
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function base64UrlToBytes(segment: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new DerError('Bad base64url');
	const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
	return base64ToBytes(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}
