-- Owned by @latentedge/appstore-notifications.
-- A family member's shared access arrives as its own notification, but the
-- money moved on the owner's transaction, so 1.0 labels it 'other'.
-- 1.0.0-rc.0 stored such rows as 'purchase'; re-label them.
UPDATE appstore_events SET event_kind = 'other' WHERE in_app_ownership_type = 'FAMILY_SHARED';
