-- Settings that follow the account between devices: the bag, Rapsodo units, and which sessions
-- feed each club (JSON), plus when they last changed (the newer change wins).
-- Apply to live BEFORE pushing the code that uses it:
--   npx wrangler d1 migrations apply nwc-golf --remote
ALTER TABLE users ADD COLUMN settings TEXT;
ALTER TABLE users ADD COLUMN settings_modified_at TEXT;
