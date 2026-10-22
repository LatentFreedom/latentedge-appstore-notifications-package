import { AppleApiKey, signAppleJwt } from './jwt';

/** Apple keeps notification history for this long. */
export const HISTORY_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

const HOSTS = {
	Production: 'https://api.storekit.itunes.apple.com',
	Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
} as const;

export interface NotificationHistoryOptions {
	key: AppleApiKey;
	bundleId: string;
	environment: 'Production' | 'Sandbox';
	/** Epoch ms. Clamped to 180 days ago; see clampHistoryStart(). */
	startDate: number;
	/** Epoch ms. Defaults to now. */
	endDate?: number;
	/** Injectable for tests and for Workers that wrap fetch. */
	fetch?: typeof fetch;
	now?: number;
}

export interface HistoryItem {
	signedPayload: string;
	/** Apple's record of each delivery attempt, as returned. */
	sendAttemptResults?: unknown[];
}

export class AppleApiError extends Error {
	readonly status: number;
	readonly errorCode?: number;

	constructor(message: string, status: number, errorCode?: number) {
		super(message);
		this.name = 'AppleApiError';
		this.status = status;
		this.errorCode = errorCode;
	}
}

/** The earliest start Apple will answer for, and whether `startDate` had to move. */
export function clampHistoryStart(startDate: number, now = Date.now()): { startDate: number; clamped: boolean } {
	// One hour of margin: a start exactly 180 days back drifts past the limit
	// by the time Apple reads the request.
	const earliest = now - HISTORY_DAYS * DAY_MS + 60 * 60 * 1000;
	return startDate < earliest ? { startDate: earliest, clamped: true } : { startDate, clamped: false };
}

/**
 * Page through Get Notification History for one app and yield each
 * notification's signedPayload. The payloads are the same signed JWS a live
 * webhook carries, so pass each one to verifyNotification(); this function
 * does not verify anything itself.
 *
 * Apple only has history for notifications it tried to send, which means
 * an app needed a Server URL set at the time.
 */
export async function* fetchNotificationHistory(options: NotificationHistoryOptions): AsyncGenerator<HistoryItem> {
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now();
	const { startDate } = clampHistoryStart(options.startDate, now);
	const body = JSON.stringify({ startDate, endDate: options.endDate ?? now });
	const token = await signAppleJwt(options.key, { bundleId: options.bundleId, now });
	const url = `${HOSTS[options.environment]}/inApps/v1/notifications/history`;

	let paginationToken: string | undefined;
	do {
		const pageUrl = paginationToken ? `${url}?paginationToken=${encodeURIComponent(paginationToken)}` : url;
		const response = await doFetch(pageUrl, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body,
		});
		if (!response.ok) {
			const error = (await response.json().catch(() => ({}))) as { errorCode?: number; errorMessage?: string };
			throw new AppleApiError(
				`Notification history request failed (${response.status})${error.errorMessage ? `: ${error.errorMessage}` : ''}`,
				response.status,
				error.errorCode
			);
		}
		const page = (await response.json()) as {
			notificationHistory?: HistoryItem[];
			hasMore?: boolean;
			paginationToken?: string;
		};
		for (const item of page.notificationHistory ?? []) {
			if (typeof item?.signedPayload === 'string') yield item;
		}
		const next = page.hasMore ? page.paginationToken : undefined;
		// A token that repeats would page forever; stop instead.
		paginationToken = next && next !== paginationToken ? next : undefined;
	} while (paginationToken);
}
