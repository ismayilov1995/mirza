-- Nəzarətçi: (1) bayrağın modellə DOĞRULANMASI, (2) menecerin 1-5 reytinqi,
-- (3) reytinq 1-dən doğan susdurma və onun audit jurnalı.
--
-- Niyə lazım oldu — üç ayrı şikayət, bir kök:
--   * deterministik düstur "43 saatdır cavabsız" deyir, amma söhbətin son
--     mesajlarını OXUYAN adam görür ki, müştəri onsuz da cavab gözləmir;
--   * "Həll edildi" bəzən kömək etmir — eyni bayraq növbəti gedişatda təzə
--     post kimi qayıdır (dedupe qaydası belədir, qəsdən);
--   * sistemin öz səhvlərindən öyrənməsi üçün heç bir qeyd yox idi.
--
-- DOĞRULAMA HAQQINDA. Bu vaxta qədər qayda belə idi: model balı yalnız AŞAĞI
-- sala bilər və 6+ olanı heç vaxt bayraq həddinin altına endirə bilməz —
-- sancağı yalnız insan çıxarır (severity.ts applyAdjustment). O qayda
-- yerindədir; bu miqrasiya onun YANINDA ikinci, dar bir yol açır: yalnız
-- Client kateqoriyalı, yalnız 6+ və yalnız son 15 mesajı OXUMUŞ ayrıca
-- çağırış, yalnız HIGH əminliklə "bu adam cavab gözləmir" deyəndə bal 5-ə
-- düşür. 5 — hələ də lentdə görünən "diqqət" zolağıdır, yəni bayraq
-- İTMİR, sadəcə sancaqdan çıxır. Şərh yazan model bunu edə bilmir; onun
-- gördüyü yalnız rəqəmlərdir, bunun gördüyü isə söhbətin özüdür.
--
-- verify_inbound_ts KEŞ AÇARIDIR. Doğrulama söhbətə TƏZƏ mesaj gələnə qədər
-- təkrarlanmır — eyni bayraq üçün eyni cavaba saatda bir pul verilməsin.
--
-- Təkrar işlətmək təhlükəsizdir.

-- ---------------------------------------------------------------- doğrulama
ALTER TABLE katibe.agent_posts
  ADD COLUMN IF NOT EXISTS verify_state      text,
  ADD COLUMN IF NOT EXISTS verify_confidence text,
  ADD COLUMN IF NOT EXISTS verify_reason     text,
  ADD COLUMN IF NOT EXISTS verify_model      text,
  -- Doğrulama anında son GƏLƏN mesajın vaxtı; keş açarı.
  ADD COLUMN IF NOT EXISTS verify_inbound_ts bigint,
  ADD COLUMN IF NOT EXISTS verified_at       timestamptz;

ALTER TABLE katibe.agent_posts
  DROP CONSTRAINT IF EXISTS agent_posts_verify_state_check;
ALTER TABLE katibe.agent_posts
  ADD CONSTRAINT agent_posts_verify_state_check
  CHECK (verify_state IS NULL OR verify_state IN ('WAITING', 'NOT_WAITING', 'UNCLEAR'));

ALTER TABLE katibe.agent_posts
  DROP CONSTRAINT IF EXISTS agent_posts_verify_confidence_check;
ALTER TABLE katibe.agent_posts
  ADD CONSTRAINT agent_posts_verify_confidence_check
  CHECK (verify_confidence IS NULL OR verify_confidence IN ('HIGH', 'MEDIUM', 'LOW'));

-- Reytinq 1 postu da bağlayır, amma səbəbi 'MANUAL' deyil: "həll etdim" ilə
-- "bu ümumiyyətlə bayraq olmamalıydı" fərqli hadisələrdir və dataset onları
-- qarışdırmamalıdır.
ALTER TABLE katibe.agent_posts
  DROP CONSTRAINT IF EXISTS agent_posts_closed_reason_check;
ALTER TABLE katibe.agent_posts
  ADD CONSTRAINT agent_posts_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN ('MANUAL', 'AUTO', 'SCOPE', 'RATED_NOISE'));

-- ------------------------------------------------------------------ reytinq
-- Menecerin bayrağa verdiyi qiymət. Post başına BİR sətir: "indi bu bayraq
-- nə dərəcədə dəyərli idi" sualının bir cavabı olur, fikir dəyişəndə sətir
-- yenilənir (previous_rating köhnəsini saxlayır ki, dataset dəyişmə faktını
-- da görsün).
--
-- Müəllif katibe.dashboard_users-dəndir (giriş hesabı), katibe.users
-- (satıcı) YOX — bax 2026-08-26_agent_post_comments.sql-dəki eyni ayrım.
CREATE TABLE IF NOT EXISTS katibe.agent_post_ratings (
  agent_post_id   bigint PRIMARY KEY REFERENCES katibe.agent_posts(id) ON DELETE CASCADE,
  rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  previous_rating smallint CHECK (previous_rating BETWEEN 1 AND 5),
  -- Reytinq 1-də modelin yazdığı "nə susduruldu" xülasəsi; qalanlarında NULL.
  summary         text,
  note            text,
  rated_by        integer NOT NULL REFERENCES katibe.dashboard_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_post_ratings_rating_idx
  ON katibe.agent_post_ratings (rating, updated_at DESC);

-- ---------------------------------------------------------------- susdurma
-- Reytinq 1 = "bu bayraq səhv idi". Susdurma həmin SÖHBƏT + həmin DETEKTOR
-- üçün açılır, instans üzrə ümumi şablon kimi yox (sahibin qərarı): yanlış
-- susdurmanın qiyməti yanlış bayraqdan qat-qat baha olduğu üçün dairə dar
-- saxlanır.
--
-- ÜÇ QAÇIŞ KLAPANI, hər biri qəsdən:
--   1. expires_at — susdurma əbədi deyil (standart 30 gün). Söhbət aylar
--      sonra tamam başqa vəziyyətə düşür.
--   2. base_severity — reytinq anındakı baza balı. Yeni tapıntının balı
--      bundan 2 vahid yüksəkdirsə susdurma işləmir (ESCALATED).
--      "Ciddiləşən problem susdurulmuş qalsın" ssenarisi bağlanır.
--   3. oxşarlıq yoxlaması — model saxlanmış xülasə ilə söhbətin HAZIRKI son
--      mesajlarını müqayisə edir; vəziyyət mahiyyətcə dəyişibsə bayraq çıxır.
--
-- Unikal indeks yalnız qüvvədə olan sətirləri tutur: eyni söhbətə ikinci dəfə
-- 1 verilsə mövcud sətir təzələnir, ləğv olunmuş sətir isə tarixçədə qalır.
CREATE TABLE IF NOT EXISTS katibe.agent_suppressions (
  id             bigserial PRIMARY KEY,
  agent          text NOT NULL DEFAULT 'nazaratchi',
  instance_id    text NOT NULL,
  remote_jid     text NOT NULL,
  detector       text NOT NULL,
  summary        text NOT NULL,
  base_severity  smallint NOT NULL CHECK (base_severity BETWEEN 1 AND 10),
  source_post_id bigint REFERENCES katibe.agent_posts(id) ON DELETE SET NULL,
  created_by     integer REFERENCES katibe.dashboard_users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '30 days',
  revoked_at     timestamptz,
  revoked_by     integer REFERENCES katibe.dashboard_users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_suppressions_active_key
  ON katibe.agent_suppressions (agent, instance_id, remote_jid, detector)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_suppressions_instance_idx
  ON katibe.agent_suppressions (instance_id, created_at DESC);

-- Susdurmanın AUDİT JURNALI — bu cədvəlin bütün mənası budur.
--
-- Susdurulmuş bayraq lentdə görünmür, deməli susdurmanın səhv olduğu heç vaxt
-- öz-özünə üzə çıxmayacaq. Ona görə hər qarşılaşma yazılır: nə susduruldu, nə
-- BURAXILDI (ESCALATED/DIFFERENT), hansı balla və model hansı səbəbi yazdı.
-- /admin/suppressions bunu göstərir; "birdən vacib bir şey sırf bu süzgəcə
-- görə itib" sualının yeganə cavab yeri budur.
CREATE TABLE IF NOT EXISTS katibe.agent_suppression_log (
  id                bigserial PRIMARY KEY,
  suppression_id    bigint NOT NULL REFERENCES katibe.agent_suppressions(id) ON DELETE CASCADE,
  run_id            bigint REFERENCES katibe.agent_runs(id),
  outcome           text NOT NULL CHECK (outcome IN ('SUPPRESSED', 'ESCALATED', 'DIFFERENT', 'EXPIRED')),
  would_be_severity smallint NOT NULL CHECK (would_be_severity BETWEEN 1 AND 10),
  reason            text,
  model             text,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_suppression_log_recent_idx
  ON katibe.agent_suppression_log (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_suppression_log_suppression_idx
  ON katibe.agent_suppression_log (suppression_id, created_at DESC);

-- Yeni katibe cədvəlləri evolution-a məxsus olmalıdır, yoxsa app və cron-lar
-- çılpaq "permission denied for table" alır (bax voice_transcript qeydi).
ALTER TABLE katibe.agent_post_ratings   OWNER TO evolution;
ALTER TABLE katibe.agent_suppressions   OWNER TO evolution;
ALTER TABLE katibe.agent_suppression_log OWNER TO evolution;
