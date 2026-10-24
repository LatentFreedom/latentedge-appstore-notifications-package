import {
	AppStoreEnvironment,
	NotificationPayload,
	RenewalInfoPayload,
	SaleEventKind,
	TransactionPayload,
	VerificationError,
	VerifiedNotification,
} from './types';
import { VerifyOptions, verifyJws } from './verify';

export interface ExpectedApp {
	bundleId: string;
	/** The app's Apple ID. Apple omits it in Sandbox, so it is enforced in Production only when absent. */
	appAppleId?: number;
}

export interface NotificationOptions extends VerifyOptions {
	/**
	 * The apps this endpoint serves. Any developer can get a real Apple-signed
	 * notification for their own app and post it to your URL; this rejects it.
	 */
	apps?: ExpectedApp[];
	/** The environments this endpoint accepts, for example ['Production'] on a live-only URL. */
	environments?: AppStoreEnvironment[];
}

/** Which app and environment a notification is about, wherever Apple put them. */
export interface NotificationIdentity {
	bundleId: string | null;
	appAppleId: number | null;
	environment: AppStoreEnvironment | null;
}

const KIND_BY_TYPE: Record<string, SaleEventKind> = {
	ONE_TIME_CHARGE: 'purchase',
	SUBSCRIBED: 'purchase',
	OFFER_REDEEMED: 'purchase',
	DID_RENEW: 'renewal',
	REFUND: 'refund',
	REFUND_REVERSED: 'refund_reversed',
	REVOKE: 'revoke',
	EXPIRED: 'expire',
	GRACE_PERIOD_EXPIRED: 'expire',
	TEST: 'test',
};

/** Map a notification type to the sale event it represents for reporting. */
export function eventKindFor(notificationType: string): SaleEventKind {
	return KIND_BY_TYPE[notificationType] ?? 'other';
}

/**
 * Read the app and environment from `data`, `summary`, or
 * `externalPurchaseToken`, whichever the notification carries.
 */
export function notificationIdentity(notification: NotificationPayload): NotificationIdentity {
	const source: Record<string, unknown> =
		(notification.data as Record<string, unknown> | undefined) ?? notification.summary ?? notification.externalPurchaseToken ?? {};
	let environment = typeof source.environment === 'string' ? (source.environment as AppStoreEnvironment) : null;
	// External purchase tokens carry no environment; Apple marks Sandbox ones by the id prefix.
	if (!environment && notification.externalPurchaseToken) {
		const id = notification.externalPurchaseToken.externalPurchaseId;
		if (typeof id === 'string') environment = id.startsWith('SANDBOX') ? 'Sandbox' : 'Production';
	}
	return {
		bundleId: typeof source.bundleId === 'string' ? source.bundleId : null,
		appAppleId: typeof source.appAppleId === 'number' ? source.appAppleId : null,
		environment,
	};
}

function checkExpected(identity: NotificationIdentity, options: NotificationOptions): void {
	if (options.environments && !(identity.environment && options.environments.includes(identity.environment))) {
		throw new VerificationError(`Notification environment ${identity.environment ?? 'is missing and'} is not accepted`);
	}
	if (!options.apps) return;
	const app = options.apps.find((candidate) => candidate.bundleId === identity.bundleId);
	if (!app) throw new VerificationError(`Notification is for an unexpected app (${identity.bundleId ?? 'no bundleId'})`);
	if (app.appAppleId === undefined) return;
	const mismatch = identity.appAppleId !== null && identity.appAppleId !== app.appAppleId;
	const missingInProduction = identity.appAppleId === null && identity.environment === 'Production';
	if (mismatch || missingInProduction) throw new VerificationError('Notification appAppleId does not match the expected app');
}

/**
 * Verify an App Store Server Notifications V2 request body and every signed
 * part inside it. Accepts the parsed JSON body (`{ signedPayload }`) or the
 * signedPayload string itself. Pass `apps` (and `environments`) so only your
 * own apps' notifications are accepted.
 */
export async function verifyNotification(
	body: { signedPayload?: unknown } | string,
	options: NotificationOptions = {}
): Promise<VerifiedNotification> {
	const signedPayload = typeof body === 'string' ? body : body?.signedPayload;
	if (typeof signedPayload !== 'string') throw new VerificationError('Missing signedPayload');

	const notification = await verifyJws<NotificationPayload>(signedPayload, options);
	if (typeof notification.notificationType !== 'string' || typeof notification.notificationUUID !== 'string') {
		throw new VerificationError('Notification is missing its type or UUID');
	}
	const identity = notificationIdentity(notification);
	// Checked before the nested parts so a foreign app's notification costs no further crypto.
	checkExpected(identity, options);

	const data = notification.data;
	const transaction = data?.signedTransactionInfo
		? await verifyJws<TransactionPayload>(data.signedTransactionInfo, options)
		: null;
	const renewalInfo = data?.signedRenewalInfo
		? await verifyJws<RenewalInfoPayload>(data.signedRenewalInfo, options)
		: null;

	// Each part is signed on its own, so valid parts from different
	// notifications could be spliced together; these checks tie them to one event.
	if (transaction && identity.bundleId && transaction.bundleId !== identity.bundleId) {
		throw new VerificationError('Transaction bundleId does not match the notification');
	}
	if (transaction && renewalInfo && renewalInfo.originalTransactionId !== transaction.originalTransactionId) {
		throw new VerificationError('Renewal info originalTransactionId does not match the transaction');
	}
	if (identity.environment) {
		if (transaction?.environment && transaction.environment !== identity.environment) {
			throw new VerificationError('Transaction environment does not match the notification');
		}
		if (renewalInfo?.environment && renewalInfo.environment !== identity.environment) {
			throw new VerificationError('Renewal info environment does not match the notification');
		}
	}

	return { notification, transaction, renewalInfo, eventKind: eventKindFor(notification.notificationType) };
}
