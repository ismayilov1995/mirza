-- Phone numbers recovered for @lid chats.
--
-- WhatsApp's LID addressing hides the phone number behind an opaque id, and it
-- cannot be reversed on demand: Baileys' getPNForLID() reads a local store and
-- returns null on a miss, with no network lookup behind it. The only mappings
-- that will ever exist are the ones WhatsApp volunteered as messages flowed.
--
-- Those live in Evolution's signal state, which on this server sits in Redis
-- (db 6, hash evolution:instance:<id>, fields lid-mapping-<lid>_reverse). They
-- carry no TTL, but Redis is a cache: a FLUSHDB or a reinstall erases them and
-- nothing can rebuild them. This table is the durable copy — append-only in
-- practice, so coverage accumulates as clients write in.
--
-- Filled by scripts/harvest-lid-numbers.ts, hourly by cron. Covered by the
-- existing katibe-schema backup.
CREATE TABLE IF NOT EXISTS katibe.lid_number (
  -- The full JID as it appears in evolution_api."Message".key->>'remoteJid',
  -- so this joins directly against chats and katibe.contact_labels.
  lid_jid       text PRIMARY KEY,
  phone_number  text NOT NULL,
  -- Which account's signal store the pairing came from; a mapping learned by
  -- one instance is still true everywhere, so this is provenance, not scope.
  instance_id   text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Going the other way — "which chat is this customer?" — is the whole point of
-- part C of docs/lid-number-recovery-plan.md, and is a lookup by number.
CREATE INDEX IF NOT EXISTS lid_number_phone_idx ON katibe.lid_number (phone_number);
