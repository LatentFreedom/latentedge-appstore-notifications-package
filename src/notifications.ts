import {
	NotificationPayload,
	RenewalInfoPayload,
	SaleEventKind,
	TransactionPayload,
	VerificationError,
	VerifiedNotification,
} from './types';
import { VerifyOptions, verifyJws } from './verify';

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
 * Verify an App Store Server Notifications V2 request body and every signed
 * part inside it. Accepts the parsed JSON body (`{ signedPayload }`) or the
 * signedPayload string itself.
 */
export async function verifyNotification(
	body: { signedPayload?: unknown } | string,
	options: VerifyOptions = {}
): Promise<VerifiedNotification> {
	const signedPayload = typeof body === 'string' ? body : body?.signedPayload;
	if (typeof signedPayload !== 'string') throw new VerificationError('Missing signedPayload');

	const notification = await verifyJws<NotificationPayload>(signedPayload, options);
	if (typeof notification.notificationType !== 'string' || typeof notification.notificationUUID !== 'string') {
		throw new VerificationError('Notification is missing its type or UUID');
	}

	const data = notification.data;
	const transaction = data?.signedTransactionInfo
		? await verifyJws<TransactionPayload>(data.signedTransactionInfo, options)
		: null;
	const renewalInfo = data?.signedRenewalInfo
		? await verifyJws<RenewalInfoPayload>(data.signedRenewalInfo, options)
		: null;

	// Each part is signed on its own, so a valid transaction from one app could
	// be spliced into another app's notification without this check.
	if (transaction && data?.bundleId && transaction.bundleId !== data.bundleId) {
		throw new VerificationError('Transaction bundleId does not match the notification');
	}

	return { notification, transaction, renewalInfo, eventKind: eventKindFor(notification.notificationType) };
}
