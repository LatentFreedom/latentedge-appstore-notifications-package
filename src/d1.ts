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
}

/** Flatten a verified notification into one appstore_events row. */
export function toEventRow(verified: VerifiedNotification): EventRow {
	const { notification, transaction, eventKind } = verified;
	const data = notification.data;
	const summaryBundle = typeof notification.summary?.bundleId === 'string' ? notification.summary.bundleId : null;
	return {
		notification_uuid: notification.notificationUUID,
		bundle_id: data?.bundleId ?? transaction?.bundleId ?? summaryBundle ?? 'unknown',
		app_apple_id: data?.appAppleId ?? null,
		environment: data?.environment ?? transaction?.environment ?? 'unknown',
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
