# @latentedge/appstore-notifications

Verify and record App Store Server Notifications V2 on Cloudflare Workers.
It uses Web Crypto only: no Node.js APIs, no App Store Server API key, and no runtime dependencies.

App Store Connect reports sales about a day late.
App Store Server Notifications arrive within seconds of a purchase, renewal, or refund.
This package turns each notification into a verified, typed sale event and stores it once in D1.

## What it checks

Every signed part of a notification is verified: the outer `signedPayload`, the `signedTransactionInfo`, and the `signedRenewalInfo`.
For each one, `verifyJws` checks that:

1. The header is `ES256` with a three-certificate `x5c` chain.
2. The chain root is byte-identical to Apple Root CA - G3, which is pinned in source.
3. The leaf carries Apple's App Store signing extension (`1.2.840.113635.100.6.11.1`) and the intermediate carries the WWDR extension (`1.2.840.113635.100.6.2.1`).
4. The intermediate and root are CAs, and every certificate is valid at the payload's `signedDate`.
5. The leaf is signed by the intermediate, and the intermediate by the root.
6. The JWS signature verifies against the leaf's P-256 key.

It also rejects a transaction whose `bundleId` differs from the notification's, so a valid transaction from one app cannot be spliced into another app's notification.
Any failure throws `VerificationError`.
Nothing is returned from an unverified token.

Revocation (OCSP) is not checked.
If you need it, confirm the transaction with the App Store Server API as well.

## Install

```sh
npm install @latentedge/appstore-notifications
```

## Use in a Worker

Apply the migration to your D1 database first:

```sh
npx wrangler d1 migrations apply <db-name> --remote
```

Copy `node_modules/@latentedge/appstore-notifications/migrations/0001_appstore_events.sql` into your Worker's `migrations/` folder, or point `migrations_dir` at it.

```ts
import { VerificationError, recordEvent, verifyNotification } from '@latentedge/appstore-notifications';

export default {
	async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
		let verified;
		try {
			verified = await verifyNotification(await request.json());
		} catch (error) {
			if (error instanceof VerificationError || error instanceof SyntaxError) {
				return new Response('Unverified notification', { status: 401 });
			}
			throw error;
		}
		// Apple retries until it gets a 200, so recordEvent ignores a repeated notificationUUID.
		await recordEvent(env.DB, verified);
		return new Response(null, { status: 200 });
	},
};
```

Then set the Worker's URL as the Production and Sandbox Server URL, Version 2, on each app's App Information page in App Store Connect.
One URL can serve every app you publish, because each row stores the app's `bundle_id`.

## API

| Export | Purpose |
|---|---|
| `verifyNotification(body, options?)` | Verify a request body (`{ signedPayload }`) or the `signedPayload` string, with its nested transaction and renewal info. Returns `{ notification, transaction, renewalInfo, eventKind }`. |
| `verifyJws(jws, options?)` | Verify any Apple-signed JWS and return its payload. |
| `eventKindFor(type)` | Map a notification type to `purchase`, `renewal`, `refund`, `refund_reversed`, `revoke`, `expire`, `test`, or `other`. |
| `recordEvent(db, verified)` | Insert one `appstore_events` row. Returns `{ inserted, row }`; `inserted` is `false` for a redelivery. |
| `toEventRow(verified)` | The row `recordEvent` writes, for apps that store events elsewhere. |
| `APPLE_ROOT_CA_G3` | The pinned root certificate (DER). |

`options.trustedRoots` replaces the pinned root and exists for tests.
`options.effectiveDate` sets the time the certificates must be valid at; it defaults to the payload's `signedDate`, as Apple's own libraries do.

## The `appstore_events` table

One row per `notificationUUID`.
`price_milliunits` is in thousandths of `currency` (`4990` is 4.99), and both are null on payloads Apple signed before it added pricing.
Sandbox and Production events share the table; filter on `environment` for real sales.
`ONE_TIME_CHARGE` covers consumables, non-consumables, and non-renewing subscriptions; `SUBSCRIBED` and `DID_RENEW` cover auto-renewable subscriptions.
Apple sends no notification for a free download.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
```

The tests sign payloads with a throwaway PKI shaped like Apple's.
Regenerate it with `test/fixtures/make-fixtures.sh`.

## License

MIT
