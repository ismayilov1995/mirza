-- Nəzarətçi (internal control) rolu — yalnız-oxu WhatsApp görünüşü.
--
-- PROBLEM. Daxili nəzarətçi indiyə qədər satıcıların WhatsApp-larını ayrı-ayrı
-- brauzerlərdə AÇIQ SESSİYA ilə yoxlayırdı. Bu, həm yazmaq imkanı deməkdir
-- (yalnız-oxu deyil), həm də hər şeyi göstərir: zakaz qrupları, orada duran
-- müştəri nömrələri, daxili yazışmalar. Nəzarətçiyə lazım olan isə yalnız
-- "qız müştəriyə necə cavab verib" sualıdır.
--
-- HƏLL. Ayrı rol + söhbət səviyyəsində görünmə qaydaları. Rol `viewer`-dən
-- ayrıdır, çünki viewer statistika, AI analizi və etiketləmə edə bilir —
-- nəzarətçi isə YALNIZ oxuyur.
--
-- QAYDA SIRASI (yuxarıdan aşağı, ilk uyğun olan qalib gəlir):
--   1. monitor_chat_rule   — konkret söhbət üçün açıq qərar (allow/deny)
--   2. monitor_category_rule — həmin söhbətin kateqoriyası üçün qərar
--   3. monitor_profile      — tipə görə default (qrup/fərdi)
--
-- DEFAULT-DENY QRUPLARDA. Qruplar default GİZLİdir: son 90 gündə 475 aktiv
-- qrup var və zakaz qrupları məhz orada. Sabah yaranan yeni qrup da avtomatik
-- gizli qalır — yəni "yeni qrup açıldı, gizlətməyi unutduq" sızması struktur
-- olaraq mümkün deyil. Fərdi söhbətlər default açıqdır, çünki işin özü odur.
--
-- Təkrar işlətmək təhlükəsizdir.

-- 1. Rol siyahısı.
ALTER TABLE katibe.dashboard_users DROP CONSTRAINT IF EXISTS dashboard_users_role_check;
ALTER TABLE katibe.dashboard_users
  ADD CONSTRAINT dashboard_users_role_check CHECK (role IN ('admin', 'viewer', 'monitor'));

-- 2. Hesab başına profil.
--
-- Sətir olmasa da nəzarətçi işləyir: kod yoxluğu "hamısı default" kimi oxuyur
-- (bax src/lib/access.ts DEFAULT_MONITOR_PROFILE). Yəni hesab yaradıb qayda
-- yazmağı unutmaq ən dar görünüş verir, ən genişini yox.
CREATE TABLE IF NOT EXISTS katibe.monitor_profile (
  user_id integer PRIMARY KEY REFERENCES katibe.dashboard_users(id) ON DELETE CASCADE,
  -- Neçə günlük yazışma görünsün. Nəzarət cari işə aiddir; illərlə arxivi
  -- birdəfəlik açmaq üçün səbəb yoxdur.
  history_days integer NOT NULL DEFAULT 90 CHECK (history_days BETWEEN 1 AND 3650),
  -- Telefon nömrələri maskalansın (+994 50 *** ** 35). Ad görünür, müştəri
  -- bazası köçürülə bilmir — narahatlığın özü bu idi.
  mask_phones boolean NOT NULL DEFAULT true,
  group_default text NOT NULL DEFAULT 'hidden' CHECK (group_default IN ('hidden', 'visible')),
  direct_default text NOT NULL DEFAULT 'visible' CHECK (direct_default IN ('hidden', 'visible')),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES katibe.dashboard_users(id) ON DELETE SET NULL
);

-- 3. Kateqoriya üzrə qayda — "Supplier söhbətlərini görməsin" bir sətirdir.
CREATE TABLE IF NOT EXISTS katibe.monitor_category_rule (
  user_id integer NOT NULL REFERENCES katibe.dashboard_users(id) ON DELETE CASCADE,
  category_id integer NOT NULL REFERENCES katibe.categories(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('allow', 'deny')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES katibe.dashboard_users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, category_id)
);

-- 4. Söhbət üzrə qayda — kateqoriyanı üstələyir.
--
-- JID-ə bağlıdır, instansa yox: eyni qrup iki satıcının telefonunda görünürsə,
-- onu bir dəfə gizlətmək kifayətdir. contact_labels ilə eyni prinsip.
CREATE TABLE IF NOT EXISTS katibe.monitor_chat_rule (
  user_id integer NOT NULL REFERENCES katibe.dashboard_users(id) ON DELETE CASCADE,
  remote_jid text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('allow', 'deny')),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES katibe.dashboard_users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, remote_jid)
);

CREATE INDEX IF NOT EXISTS monitor_chat_rule_jid_idx ON katibe.monitor_chat_rule (remote_jid);

-- 5. Audit.
--
-- Nəzarətçini nəzarətdə saxlayan yer. İki tərəfə də lazımdır: sahibi "kimin
-- yazışmasına kim baxıb" sualına cavab ala bilir, nəzarətçi isə haqsız
-- ittihamdan qorunur. Söhbət başına 5 dəqiqədə bir sətir yazılır (bax
-- logMonitorView) — yəni açıq qalan səhifə jurnalı şişirtmir.
CREATE TABLE IF NOT EXISTS katibe.monitor_view_log (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES katibe.dashboard_users(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  remote_jid text,
  action text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS monitor_view_log_user_idx ON katibe.monitor_view_log (user_id, at DESC);
CREATE INDEX IF NOT EXISTS monitor_view_log_jid_idx ON katibe.monitor_view_log (remote_jid, at DESC);
