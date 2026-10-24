import { notificationIdentity } from './notifications';
import { VerifiedNotification } from './types';

/**
 * The slice of D1Database this module calls. Declared here so consumers do not
 * need @cloudflare/workers-types to match versions with the package.
 */
export interface D1Like {
	prepare(query: string): {
		bind(...values: unknown[]): {
			run(): Promise<{ meta: { changes?: number } }>;
		};
	};
}

export interface EventRow {
	notification_uuid: string;
	bundle_id: string;
	app_apple_id: number | null;
	environment: string;
	notification_type: string;
	subtype: string | null;
	event_kind: string;
	product_id: string | null;
	transaction_id: string | null;
	original_transaction_id: string | null;
	price_milliunits: number | null;
	currency: string | null;
	storefront: string | null;
	signed_date: number;
	signed_payload: string | null;
	product_type: string | null;
	purchase_date: number | null;
	expires_date: number | null;
	revocation_date: number | null;
	revocation_reason: number | null;
	transaction_reason: string | null;
	in_app_ownership_type: string | null;
	quantity: number | null;
	offer_type: number | null;
	app_account_token: string | null;
}

/** Flatten a verified notification into one appstore_events row. */
export function toEventRow(verified: VerifiedNotification): EventRow {
	const { notification, transaction, eventKind } = verified;
	const identity = notificationIdentity(notification);
	return {
		notification_uuid: notification.notificationUUID,
		bundle_id: identity.bundleId ?? transaction?.bundleId ?? 'unknown',
		app_apple_id: identity.appAppleId,
		environment: identity.environment ?? transaction?.environment ?? 'unknown',
		notification_type: notification.notificationType,
		subtype: notification.subtype ?? null,
		event_kind: eventKind,
		product_id: transaction?.productId ?? null,
		transaction_id: transaction?.transactionId ?? null,
		original_transaction_id: transaction?.originalTransactionId ?? null,
		price_milliunits: transaction?.price ?? null,
		currency: transaction?.currency ?? null,
		storefront: transaction?.storefront ?? null,
		signed_date: notification.signedDate,
		signed_payload: verified.signedPayload ?? null,
		product_type: transaction?.type ?? null,
		purchase_date: transaction?.purchaseDate ?? null,
		expires_date: transaction?.expiresDate ?? null,
		revocation_date: transaction?.revocationDate ?? null,
		revocation_reason: transaction?.revocationReason ?? null,
		transaction_reason: transaction?.transactionReason ?? null,
		in_app_ownership_type: transaction?.inAppOwnershipType ?? null,
		quantity: transaction?.quantity ?? null,
		offer_type: transaction?.offerType ?? null,
		app_account_token: transaction?.appAccountToken ?? null,
	};
}

const COLUMNS = [
	'notification_uuid',
	'bundle_id',
	'app_apple_id',
	'environment',
	'notification_type',
	'subtype',
	'event_kind',
	'product_id',
	'transaction_id',
	'original_transaction_id',
	'price_milliunits',
	'currency',
	'storefront',
	'signed_date',
	'signed_payload',
	'product_type',
	'purchase_date',
	'expires_date',
	'revocation_date',
	'revocation_reason',
	'transaction_reason',
	'in_app_ownership_type',
	'quantity',
	'offer_type',
	'app_account_token',
] as const satisfies readonly (keyof EventRow)[];

const INSERT_SQL = `INSERT OR IGNORE INTO appstore_events (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`;

/**
 * Store a verified notification once. Returns `inserted: false` when the
 * notificationUUID is already recorded, which is the normal result of an
 * Apple redelivery.
 */
export async function recordEvent(db: D1Like, verified: VerifiedNotification): Promise<{ inserted: boolean; row: EventRow }> {
	const row = toEventRow(verified);
	const result = await db
		.prepare(INSERT_SQL)
		.bind(...COLUMNS.map((column) => row[column]))
		.run();
	return { inserted: (result.meta.changes ?? 0) > 0, row };
}
