-- 1.0 columns for appstore_events.
-- Owned by @latentedge/appstore-notifications.
-- Apply before deploying 1.0: recordEvent names these columns, so an insert
-- fails without them (Apple then retries, so no notification is lost).

-- The verified JWS exactly as Apple sent it, so a later version can re-derive
-- new columns from rows already stored instead of losing them.
ALTER TABLE appstore_events ADD COLUMN signed_payload TEXT;
-- Transaction type: 'Consumable', 'Non-Consumable', 'Auto-Renewable Subscription', 'Non-Renewing Subscription'.
ALTER TABLE appstore_events ADD COLUMN product_type TEXT;
ALTER TABLE appstore_events ADD COLUMN purchase_date INTEGER;
ALTER TABLE appstore_events ADD COLUMN expires_date INTEGER;
ALTER TABLE appstore_events ADD COLUMN revocation_date INTEGER;
ALTER TABLE appstore_events ADD COLUMN revocation_reason INTEGER;
-- 'PURCHASE' or 'RENEWAL'.
ALTER TABLE appstore_events ADD COLUMN transaction_reason TEXT;
-- 'PURCHASED' or 'FAMILY_SHARED'.
ALTER TABLE appstore_events ADD COLUMN in_app_ownership_type TEXT;
ALTER TABLE appstore_events ADD COLUMN quantity INTEGER;
ALTER TABLE appstore_events ADD COLUMN offer_type INTEGER;
-- The UUID your app set at purchase, which links a sale to your own user.
ALTER TABLE appstore_events ADD COLUMN app_account_token TEXT;

CREATE INDEX IF NOT EXISTS idx_appstore_events_original_transaction ON appstore_events(original_transaction_id);
