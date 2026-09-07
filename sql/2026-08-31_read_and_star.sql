-- Two marks a reader leaves on the archive: "I have read this" and "come back
-- to this".
--
-- THE READ MARKER NEVER REACHES WHATSAPP. This is the one rule the whole file
-- exists under. Katibe does not mark chats or messages as read on the account
-- it watches — a customer must never see a blue tick because someone here
-- opened a conversation to look at it. What follows is a mark in OUR database,
-- belonging to a dashboard user, invisible to the phone on the other end.
--
-- That distinction is why this is a table and not a call into Evolution. There
-- is an API for marking a chat read; nothing in this codebase may use it, and
-- keeping our own marker is what removes the temptation. The unread count on
-- the screen is computed here, from a timestamp, and means "since I last
-- looked" rather than "delivered but unopened".
--
-- Per user, not per instance: two people watching the same conversation follow
-- up independently, and one of them opening it must not clear the other's.
CREATE TABLE IF NOT EXISTS katibe.read_marker (
  user_id      integer NOT NULL REFERENCES katibe.dashboard_users(id) ON DELETE CASCADE,
  chat_id      bigint  NOT NULL REFERENCES katibe.chat(id) ON DELETE CASCADE,
  last_read_ts integer NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_id)
);

COMMENT ON TABLE katibe.read_marker IS
  'Yalnız bizim tərəfdə oxunma izi. WhatsApp-a HEÇ VAXT göndərilmir — müştəri '
  'mavi tik görmür. "Sonuncu dəfə nə vaxta qədər baxmışam" deməkdir.';

-- Only ever moves forward. Reopening an old conversation to check something
-- must not resurrect a hundred messages as unread, which is what a plain
-- assignment would do the moment someone scrolls up and the client sends the
-- timestamp it happens to be looking at.
COMMENT ON COLUMN katibe.read_marker.last_read_ts IS
  'Yalnız irəli gedir (GREATEST ilə yazılır) — köhnə söhbəti açmaq oxunmuşları '
  'geri qaytarmamalıdır.';

-- "Come back to this."
--
-- A note is optional here, unlike the mandatory one on closing a flag: closing
-- removes something from another person's attention and has to be justified,
-- whereas starring only adds to your own list. Making it mandatory would mean
-- fewer stars, not better ones.
CREATE TABLE IF NOT EXISTS katibe.starred_message (
  user_id    integer NOT NULL REFERENCES katibe.dashboard_users(id) ON DELETE CASCADE,
  message_id bigint  NOT NULL REFERENCES katibe.message(id) ON DELETE CASCADE,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

-- The star list is read "newest first, mine only", and the message list is
-- read "which of these on screen are starred" — the primary key serves the
-- second, this index serves the first.
CREATE INDEX IF NOT EXISTS starred_message_recent_idx
  ON katibe.starred_message (user_id, created_at DESC);

-- Where "unread" starts counting from.
--
-- Unread means "arrived since I last opened this", and with no marker at all
-- it means "since the beginning" — which across a nine-year archive reads as
-- 6,871 unread on a conversation somebody answers every morning. The number is
-- arithmetically right and completely useless.
--
-- So every conversation that already exists is marked read up to its last
-- message: the feature starts from today for everyone, and counts from there.
-- A conversation that starts AFTER this runs has no marker and so counts in
-- full, which is what it should do — it is genuinely new.
--
-- Idempotent, like everything else here: ON CONFLICT DO NOTHING means a second
-- run does not silently re-mark conversations somebody has since read.
INSERT INTO katibe.read_marker (user_id, chat_id, last_read_ts)
SELECT u.id, c.id, COALESCE(c.last_ts, 0)
  FROM katibe.dashboard_users u
  CROSS JOIN katibe.chat c
 WHERE u.active
ON CONFLICT (user_id, chat_id) DO NOTHING;

-- "Bu söhbəti açıb oxumuşam" ilə "hələ baxmamışam" arasındakı fərq.
--
-- last_read_ts tək başına bunu deyə bilmir, çünki yuxarıdakı toxum HƏR söhbətə
-- iz qoydu — yəni "izi var" artıq "baxılıb" demək deyil. Nəzarətçinin ekranda
-- görməli olduğu isə məhz budur: bu yazışmanı açıb oxudummu, yoxsa yox.
--
-- Ona görə ayrıca sütun: toxum onu NULL buraxır, yalnız söhbət həqiqətən
-- açılanda dolur. NULL = bir dəfə də açılmayıb.
ALTER TABLE katibe.read_marker
  ADD COLUMN IF NOT EXISTS opened_at timestamptz;

COMMENT ON COLUMN katibe.read_marker.opened_at IS
  'Söhbətin bu istifadəçi tərəfindən İLK dəfə nə vaxt açıldığı. NULL = heç '
  'vaxt açılmayıb (toxum sətirləri belədir).';

-- Neçənci dəfə açıldığı da faydalıdır: bir dəfə göz gəzdirmək ilə hər gün
-- qayıtmaq eyni şey deyil, və nəzarətçinin işini ölçəndə bu fərq görünür.
ALTER TABLE katibe.read_marker
  ADD COLUMN IF NOT EXISTS opened_count integer NOT NULL DEFAULT 0;
