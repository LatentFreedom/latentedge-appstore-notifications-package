# Security

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.
Include the version, what an attacker can do, and the smallest input that shows it, such as a JWS that verifies when it should not.

We confirm a report within a few days and publish a fixed version before the advisory.

The verification path (`src/der.ts`, `src/x509.ts`, `src/verify.ts`, `src/roots.ts`) is the part where a bug matters most.
