-- Dashboard giriş hesabları və instans səviyyəsində giriş nəzarəti.
--
-- Bundan əvvəl giriş bir paylaşılan parol idi (DASHBOARD_PASSWORD) və sessiya
-- cookie-si heç bir şəxsiyyət daşımırdı — ona görə "kim" sualı verilə bilmirdi,
-- deməli "nəyi görə bilər" sualı da verilə bilmirdi. Bu miqrasiya həmin sualın
-- cavabını saxlayan yeri yaradır.
--
-- DİQQƏT: katibe.users SATICILARDIR (ölçülən adamlar), giriş hesabı deyil.
-- Giriş hesabları burada, ayrı cədvəldədir. İkisini qarışdırmaq olmaz: bir
-- satıcının hesabı olmaya bilər, bir hesab heç bir satıcıya aid olmaya bilər.
--
-- Təkrar işlətmək təhlükəsizdir.

CREATE TABLE IF NOT EXISTS katibe.dashboard_users (
  id                   serial PRIMARY KEY,
  username             text NOT NULL,
  email                text,
  -- Format: scrypt$N$r$p$<base64 salt>$<base64 hash>. Alqoritm adı içəridədir ki,
  -- gələcəkdə parametrləri artırmaq və ya argon2-yə keçmək köhnə hashları
  -- sındırmasın — hər hash özünü necə yoxlamağı deyir.
  password_hash        text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('admin', 'viewer')),
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  password_changed_at  timestamptz,
  -- Sessiya ləğvi. Cookie bu rəqəmi daşıyır; uyğun gəlmirsə sessiya ölür.
  -- Hesab söndürüləndə, parol dəyişəndə və ya rol dəyişəndə artırılır — yəni
  -- səlahiyyəti azaldılan adamın açıq sessiyası dərhal qüvvədən düşür.
  session_epoch        integer NOT NULL DEFAULT 0,
  -- Bu hesab hansı satıcıya aiddir — yalnız audit/rahatlıq üçün. Giriş
  -- icazəsi BURADAN GƏLMİR (bax dashboard_user_instances).
  katibe_user_id       integer REFERENCES katibe.users(id) ON DELETE SET NULL,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           integer REFERENCES katibe.dashboard_users(id) ON DELETE SET NULL
);

-- Böyük/kiçik hərf fərqi olmadan unikal: "Ismayil" və "ismayil" bir hesabdır.
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_users_username_key
  ON katibe.dashboard_users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_users_email_key
  ON katibe.dashboard_users (lower(email)) WHERE email IS NOT NULL;

-- Açıq icazə. Viewer üçün bu, gördüklərinin TAM siyahısıdır; admin üçün isə
-- yalnız privat instanslara əlavə açardır (bax katibe.instance_access).
CREATE TABLE IF NOT EXISTS katibe.dashboard_user_instances (
  user_id     integer NOT NULL REFERENCES katibe.dashboard_users(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  integer REFERENCES katibe.dashboard_users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, instance_id)
);

CREATE INDEX IF NOT EXISTS dashboard_user_instances_instance_idx
  ON katibe.dashboard_user_instances (instance_id);

-- İnstansın məxfilik bayrağı.
--
-- Evolution-un öz "Instance" cədvəlinə sütun əlavə etmirik (o, Prisma-nındır və
-- miqrasiyaları bizim dəyişikliyi silərdi) — ona görə ayrı cədvəl.
--
-- QAYDA: privat instans yalnız açıq icazəsi olana görünür, ROLDAN ASILI OLMAYARAQ.
-- Bu, "admin hər şeyi görür" qaydasının yeganə istisnasıdır və qəsdən belədir:
-- sabah yaranan admin sahibin şəxsi nömrəsini görməməlidir və bunun üçün heç
-- kimin heç nəyi yadda saxlaması tələb olunmamalıdır (default-deny).
CREATE TABLE IF NOT EXISTS katibe.instance_access (
  instance_id text PRIMARY KEY,
  private     boolean NOT NULL DEFAULT false,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
