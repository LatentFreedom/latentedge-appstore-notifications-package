export type AppStoreEnvironment = 'Sandbox' | 'Production' | 'Xcode' | 'LocalTesting';

/** responseBodyV2DecodedPayload - the outer notification. */
export interface NotificationPayload {
	notificationType: string;
	subtype?: string;
	notificationUUID: string;
	version?: string;
	/** Epoch ms when Apple signed the notification. */
	signedDate: number;
	data?: NotificationData;
	/** Present instead of `data` on summary notifications such as RENEWAL_EXTENSION. */
	summary?: Record<string, unknown>;
	externalPurchaseToken?: Record<string, unknown>;
}

export interface NotificationData {
	appAppleId?: number;
	bundleId?: string;
	bundleVersion?: string;
	environment?: AppStoreEnvironment;
	signedTransactionInfo?: string;
	signedRenewalInfo?: string;
	status?: number;
	consumptionRequestReason?: string;
}

/** JWSTransactionDecodedPayload. */
export interface TransactionPayload {
	transactionId: string;
	originalTransactionId: string;
	bundleId: string;
	productId: string;
	/** 'Consumable' | 'Non-Consumable' | 'Auto-Renewable Subscription' | 'Non-Renewing Subscription' */
	type: string;
	purchaseDate: number;
	originalPurchaseDate?: number;
	expiresDate?: number;
	quantity?: number;
	signedDate: number;
	environment: AppStoreEnvironment;
	storefront?: string;
	storefrontId?: string;
	/** ISO 4217 code. Absent on payloads Apple signed before it added pricing. */
	currency?: string;
	/** Price in milliunits of `currency`: 1990 means 1.99. */
	price?: number;
	transactionReason?: 'PURCHASE' | 'RENEWAL';
	inAppOwnershipType?: 'PURCHASED' | 'FAMILY_SHARED';
	revocationDate?: number;
	revocationReason?: number;
	webOrderLineItemId?: string;
	subscriptionGroupIdentifier?: string;
	appAccountToken?: string;
	offerType?: number;
	offerIdentifier?: string;
	appTransactionId?: string;
}

/** JWSRenewalInfoDecodedPayload (fields used for reporting; Apple sends more). */
export interface RenewalInfoPayload {
	originalTransactionId: string;
	autoRenewProductId?: string;
	productId?: string;
	autoRenewStatus?: number;
	expirationIntent?: number;
	signedDate: number;
	environment: AppStoreEnvironment;
	renewalPrice?: number;
	currency?: string;
	[key: string]: unknown;
}

export type SaleEventKind =
	| 'purchase'
	| 'renewal'
	| 'refund'
	| 'refund_reversed'
	| 'revoke'
	| 'expire'
	| 'test'
	| 'other';

/** A notification whose every signed part has been verified. */
export interface VerifiedNotification {
	notification: NotificationPayload;
	transaction: TransactionPayload | null;
	renewalInfo: RenewalInfoPayload | null;
	eventKind: SaleEventKind;
}

export class VerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VerificationError';
	}
}
