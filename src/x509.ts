import { DerError, DerNode, TAG, bytesEqual, children, decodeOid, decodeTime, ecdsaDerToRaw, expectTag, readNode } from './der';

const OID = {
	EC_PUBLIC_KEY: '1.2.840.10045.2.1',
	P256: '1.2.840.10045.3.1.7',
	P384: '1.3.132.0.34',
	ECDSA_SHA256: '1.2.840.10045.4.3.2',
	ECDSA_SHA384: '1.2.840.10045.4.3.3',
	BASIC_CONSTRAINTS: '2.5.29.19',
} as const;

const CURVES: Record<string, { name: 'P-256' | 'P-384'; size: number }> = {
	[OID.P256]: { name: 'P-256', size: 32 },
	[OID.P384]: { name: 'P-384', size: 48 },
};

const HASHES: Record<string, 'SHA-256' | 'SHA-384'> = {
	[OID.ECDSA_SHA256]: 'SHA-256',
	[OID.ECDSA_SHA384]: 'SHA-384',
};

export interface Certificate {
	der: Uint8Array;
	tbs: Uint8Array;
	signatureHash: 'SHA-256' | 'SHA-384';
	signature: Uint8Array;
	issuer: Uint8Array;
	subject: Uint8Array;
	notBefore: number;
	notAfter: number;
	spki: Uint8Array;
	curve: { name: 'P-256' | 'P-384'; size: number };
	isCa: boolean;
	extensionOids: Set<string>;
}

function bitStringBytes(node: DerNode): Uint8Array {
	// The first value byte counts unused trailing bits; keys and signatures always use whole bytes.
	if (node.value[0] !== 0) throw new DerError('Unexpected unused bits in BIT STRING');
	return node.value.subarray(1);
}

function algorithmOid(node: DerNode): string {
	const [oid] = children(expectTag(node, TAG.SEQUENCE, 'AlgorithmIdentifier'));
	return decodeOid(expectTag(oid, TAG.OID, 'algorithm OID').value);
}

/** Parse the fields of an EC X.509 certificate that chain verification needs. */
export function parseCertificate(der: Uint8Array): Certificate {
	const { node: root, next } = readNode(der);
	if (next !== der.length) throw new DerError('Trailing bytes after certificate');
	const [tbsNode, sigAlgNode, sigNode, extra] = children(expectTag(root, TAG.SEQUENCE, 'Certificate'));
	if (extra) throw new DerError('Extra fields in Certificate');

	const tbsFields = children(expectTag(tbsNode, TAG.SEQUENCE, 'TBSCertificate'));
	// Version is optional and tagged [0]; v3 certificates (all Apple ones) carry it.
	let i = tbsFields[0]?.tag === TAG.CONTEXT_0 ? 1 : 0;
	expectTag(tbsFields[i++], TAG.INTEGER, 'serial number');
	const innerSigAlg = algorithmOid(tbsFields[i++]);
	const issuer = expectTag(tbsFields[i++], TAG.SEQUENCE, 'issuer').raw;
	const [notBeforeNode, notAfterNode] = children(expectTag(tbsFields[i++], TAG.SEQUENCE, 'validity'));
	const subject = expectTag(tbsFields[i++], TAG.SEQUENCE, 'subject').raw;
	const spkiNode = expectTag(tbsFields[i++], TAG.SEQUENCE, 'subjectPublicKeyInfo');

	const [keyAlgNode] = children(spkiNode);
	const [keyAlgOid, curveOid] = children(expectTag(keyAlgNode, TAG.SEQUENCE, 'key algorithm'));
	if (decodeOid(expectTag(keyAlgOid, TAG.OID, 'key algorithm OID').value) !== OID.EC_PUBLIC_KEY) {
		throw new DerError('Certificate key is not an EC key');
	}
	const curve = CURVES[decodeOid(expectTag(curveOid, TAG.OID, 'curve OID').value)];
	if (!curve) throw new DerError('Unsupported EC curve');

	const extensionOids = new Set<string>();
	let isCa = false;
	const extensionsWrapper = tbsFields.slice(i).find((node) => node.tag === TAG.CONTEXT_3);
	if (extensionsWrapper) {
		const [extensions] = children(extensionsWrapper);
		for (const extension of children(expectTag(extensions, TAG.SEQUENCE, 'extensions'))) {
			const fields = children(expectTag(extension, TAG.SEQUENCE, 'extension'));
			const oid = decodeOid(expectTag(fields[0], TAG.OID, 'extension OID').value);
			extensionOids.add(oid);
			if (oid === OID.BASIC_CONSTRAINTS) {
				const octets = expectTag(fields[fields.length - 1], TAG.OCTET_STRING, 'extension value');
				const [constraint] = children(readNode(octets.value).node);
				isCa = constraint?.tag === TAG.BOOLEAN && constraint.value[0] !== 0;
			}
		}
	}

	const outerSigAlg = algorithmOid(sigAlgNode);
	// RFC 5280 requires the inner and outer algorithm to match; a mismatch is a forgery signal.
	if (outerSigAlg !== innerSigAlg) throw new DerError('Signature algorithm mismatch');
	const signatureHash = HASHES[outerSigAlg];
	if (!signatureHash) throw new DerError('Unsupported signature algorithm');

	return {
		der,
		tbs: tbsNode.raw,
		signatureHash,
		signature: bitStringBytes(expectTag(sigNode, TAG.BIT_STRING, 'signature')),
		issuer,
		subject,
		notBefore: decodeTime(notBeforeNode),
		notAfter: decodeTime(notAfterNode),
		spki: spkiNode.raw,
		curve,
		isCa,
		extensionOids,
	};
}

export function importPublicKey(cert: Certificate): Promise<CryptoKey> {
	return crypto.subtle.importKey('spki', cert.spki as BufferSource, { name: 'ECDSA', namedCurve: cert.curve.name }, false, ['verify']);
}

/** True when `issuer` signed `cert`. */
export async function isSignedBy(cert: Certificate, issuer: Certificate): Promise<boolean> {
	if (!bytesEqual(cert.issuer, issuer.subject)) return false;
	const key = await importPublicKey(issuer);
	let raw: Uint8Array;
	try {
		raw = ecdsaDerToRaw(cert.signature, issuer.curve.size);
	} catch {
		return false;
	}
	return crypto.subtle.verify({ name: 'ECDSA', hash: cert.signatureHash }, key, raw as BufferSource, cert.tbs as BufferSource);
}
