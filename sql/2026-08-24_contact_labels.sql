-- Global contact/group naming. A WhatsApp JID (a phone number's
-- @s.whatsapp.net or a group's @g.us) means the same real-world contact
-- or group everywhere it shows up, so naming it should not be repeated
-- per instance. Replaces the instance-scoped katibe.chat_labels — which
-- shipped empty and is dropped here — with a JID-keyed table.
--
-- Not to be confused with katibe.users (Katibe's own staff/employee
-- records, mapped to instances by the admin) — this is naming for the
-- *other side* of the conversation: opaque numbers/group IDs like
-- "994500000001-1591964642@g.us" that carry no readable name from
-- WhatsApp itself.
CREATE TABLE IF NOT EXISTS katibe.contact_labels (
  remote_jid   text PRIMARY KEY,
  display_name text NOT NULL,
  category_id  integer REFERENCES katibe.categories(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DROP TABLE IF EXISTS katibe.chat_labels;
