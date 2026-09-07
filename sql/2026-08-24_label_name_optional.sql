-- A label row may now carry only a category.
--
-- Needed because most chats already have a perfectly good name from WhatsApp
-- (a group subject or a contact's pushName) and only need categorizing. Before
-- this, storing a category meant inventing a display_name, which would freeze
-- a name that WhatsApp keeps up to date on its own.
--
-- katibe.contact_labels now means "the admin's decisions about this JID" —
-- a name, a category, or both.
ALTER TABLE katibe.contact_labels ALTER COLUMN display_name DROP NOT NULL;
