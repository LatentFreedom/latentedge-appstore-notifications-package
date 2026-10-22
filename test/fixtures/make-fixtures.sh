#!/usr/bin/env bash
# Regenerate the test PKI: a root, an intermediate, and a leaf shaped like
# Apple's (same curves, CA flags, and marker extensions), plus a second
# "other" root chain the verifier must reject. Test-only keys; never trusted
# outside test/.
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat > "$work/ext.cnf" <<'EOF'
[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
1.2.840.113635.100.6.2.1 = ASN1:NULL
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
1.2.840.113635.100.6.11.1 = ASN1:NULL
EOF

make_chain() {
	local prefix=$1
	openssl ecparam -name secp384r1 -genkey -noout -out "$work/$prefix-root.key"
	openssl req -new -x509 -key "$work/$prefix-root.key" -sha384 -days 7300 -set_serial 1 \
		-subj "/CN=Test Root $prefix/O=Test" \
		-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
		-outform DER -out "$prefix-root.der"
	openssl x509 -inform DER -in "$prefix-root.der" -out "$work/$prefix-root.pem"

	openssl ecparam -name secp384r1 -genkey -noout -out "$work/$prefix-int.key"
	openssl req -new -key "$work/$prefix-int.key" -subj "/CN=Test Intermediate $prefix/O=Test" -out "$work/$prefix-int.csr"
	openssl x509 -req -in "$work/$prefix-int.csr" -CA "$work/$prefix-root.pem" -CAkey "$work/$prefix-root.key" \
		-set_serial 2 -days 7000 -sha384 -extfile "$work/ext.cnf" -extensions intermediate \
		-outform DER -out "$prefix-intermediate.der"
	openssl x509 -inform DER -in "$prefix-intermediate.der" -out "$work/$prefix-int.pem"

	openssl ecparam -name prime256v1 -genkey -noout -out "$work/$prefix-leaf.key"
	openssl req -new -key "$work/$prefix-leaf.key" -subj "/CN=Test Leaf $prefix/O=Test" -out "$work/$prefix-leaf.csr"
	openssl x509 -req -in "$work/$prefix-leaf.csr" -CA "$work/$prefix-int.pem" -CAkey "$work/$prefix-int.key" \
		-set_serial 3 -days 3650 -sha384 -extfile "$work/ext.cnf" -extensions leaf \
		-outform DER -out "$prefix-leaf.der"
	openssl pkcs8 -topk8 -nocrypt -in "$work/$prefix-leaf.key" -out "$prefix-leaf.pkcs8.pem"
}

make_chain test
make_chain other
echo "fixtures written to $(pwd)"
