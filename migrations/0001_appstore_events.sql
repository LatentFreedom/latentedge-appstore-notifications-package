-- Ledger of verified App Store Server Notifications V2.
-- Owned by @latentedge/appstore-notifications.
-- One row per notificationUUID: Apple redelivers until it gets a 200, so the
-- primary key is what makes a retry harmless.
CREATE TABLE IF NOT EXISTS appstore_events (
	notification_uuid TEXT PRIMARY KEY,
	bundle_id TEXT NOT NULL,
	app_apple_id INTEGER,
	environment TEXT NOT NULL,
	notification_type TEXT NOT NULL,
	subtype TEXT,
	event_kind TEXT NOT NULL,
	product_id TEXT,
	transaction_id TEXT,
	original_transaction_id TEXT,
	-- Milliunits of currency (1990 = 1.99); null on payloads signed before Apple added pricing.
	price_milliunits INTEGER,
	currency TEXT,
	storefront TEXT,
	signed_date INTEGER NOT NULL,
	received_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_appstore_events_bundle_signed ON appstore_events(bundle_id, signed_date);
CREATE INDEX IF NOT EXISTS idx_appstore_events_transaction ON appstore_events(transaction_id);
