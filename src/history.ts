import { AppleApiKey, signAppleJwt } from './jwt';

/** Apple keeps Production notification history for this long. */
export const HISTORY_DAYS = 180;
/** Sandbox history is shorter; Apple rejects an older start with errorCode 4000012. */
export const SANDBOX_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** signAppleJwt's default lifetime. */
const TOKEN_LIFETIME_MS = 1200 * 1000;
/** Renew this long before expiry so a slow request never arrives with a dead token. */
const TOKEN_RENEW_MARGIN_MS = 120 * 1000;
const MAX_WAIT_MS = 30 * 1000;

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500;
}

/** Apple's Retry-After in seconds when it sends one, else 1 s, 2 s, 4 s, ... capped at 30 s. */
function retryDelay(response: Response, attempt: number): number {
	const header = response.headers.get('Retry-After');
	const seconds = header === null ? NaN : Number(header);
	// An HTTP-date Retry-After parses as NaN and falls back to backoff.
	const ms = seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt;
	return Math.min(ms, MAX_WAIT_MS);
}

async function apiError(response: Response): Promise<AppleApiError> {
	const error = (await response.json().catch(() => ({}))) as { errorCode?: number; errorMessage?: string };
	// Apple sends a bare 401 for a bad token, and also in Production for an
	// app that is not on the App Store yet; say both, since neither has a body.
	const hint =
		response.status === 401
			? ': check the key, issuer ID, and bundle ID; in Production this also means the app is not released yet'
			: error.errorMessage
				? `: ${error.errorMessage}`
				: '';
	return new AppleApiError(`Notification history request failed (${response.status})${hint}`, response.status, error.errorCode);
}

const HOSTS = {
	Production: 'https://api.storekit.itunes.apple.com',
	Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
} as const;

export interface NotificationHistoryOptions {
	key: AppleApiKey;
	bundleId: string;
	environment: 'Production' | 'Sandbox';
	/** Epoch ms. Clamped to 180 days ago (30 in Sandbox); see clampHistoryStart(). */
	startDate: number;
	/** Epoch ms. Defaults to now. */
	endDate?: number;
	/** Injectable for tests and for Workers that wrap fetch. */
	fetch?: typeof fetch;
	/** Epoch ms the request window is measured from. Defaults to now. */
	now?: number;
	/** Times to resend a page after a 429 or 5xx. Each retry is one more Worker subrequest. Defaults to 3. */
	maxRetries?: number;
	/** Injectable for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests; decides when the bearer token needs renewing. */
	clock?: () => number;
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
export function clampHistoryStart(
	startDate: number,
	now = Date.now(),
	environment: 'Production' | 'Sandbox' = 'Production'
): { startDate: number; clamped: boolean } {
	const days = environment === 'Sandbox' ? SANDBOX_HISTORY_DAYS : HISTORY_DAYS;
	// One hour of margin: a start exactly at the limit drifts past it by the
	// time Apple reads the request.
	const earliest = now - days * DAY_MS + 60 * 60 * 1000;
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
	const clock = options.clock ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const maxRetries = options.maxRetries ?? 3;
	const now = options.now ?? Date.now();
	const { startDate } = clampHistoryStart(options.startDate, now, options.environment);
	const body = JSON.stringify({ startDate, endDate: options.endDate ?? now });
	const url = `${HOSTS[options.environment]}/inApps/v1/notifications/history`;

	let token = await signAppleJwt(options.key, { bundleId: options.bundleId, now });
	let tokenExpiresAt = now + TOKEN_LIFETIME_MS;
	// A backfill can outlive one token, so renew it between requests.
	const bearer = async (): Promise<string> => {
		const at = clock();
		if (tokenExpiresAt - at < TOKEN_RENEW_MARGIN_MS) {
			token = await signAppleJwt(options.key, { bundleId: options.bundleId, now: at });
			tokenExpiresAt = at + TOKEN_LIFETIME_MS;
		}
		return token;
	};

	let paginationToken: string | undefined;
	do {
		const pageUrl = paginationToken ? `${url}?paginationToken=${encodeURIComponent(paginationToken)}` : url;
		let response: Response;
		for (let attempt = 0; ; attempt++) {
			response = await doFetch(pageUrl, {
				method: 'POST',
				headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
				body,
			});
			if (response.ok || !isRetryable(response.status) || attempt >= maxRetries) break;
			// Apple rate-limits per key; waiting and resending the same page is safe because the request has no side effects.
			await sleep(retryDelay(response, attempt));
		}
		if (!response.ok) throw await apiError(response);
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
