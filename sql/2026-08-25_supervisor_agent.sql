-- Nəzarətçi Agent: avtonom nəzarətçinin gedişatları və lentə yazdığı postlar.
--
-- İki cədvəl:
--   agent_runs  — hər 2 saatlıq yoxlamanın özü: pəncərə, status, token xərci.
--   agent_posts — lentdə görünən hər "mesaj": tapıntı, sakitlik hesabatı və s.
--
-- SEVERITY İKİ SÜTUNDUR, QƏSDƏN. base_severity deterministik düsturdan gəlir
-- (src/lib/supervisor/severity.ts) və heç vaxt dəyişmir; severity isə modelin
-- ±2 düzəlişindən sonrakı son rəqəmdir, səbəbi severity_reason-da. Beləcə
-- "niyə 7?" sualının cavabı həmişə bazada durur — model nə qədər inandırıcı
-- yazsa da, düsturun dediyi rəqəm auditə açıq qalır.
--
-- DEDUPE AÇIQ POSTLAR ÜZƏRİNDƏDİR. Unikal indeks yalnız acknowledged_at IS
-- NULL sətirləri tutur: eyni problem növbəti gedişatda yenidən görünəndə
-- mövcud açıq post yerində yenilənir (times_seen artır), lent zibillənmir.
-- "Həll edildi" basılandan sonra isə eyni problem TƏZƏ post kimi qayıdır —
-- bağlanmış xəbərdarlığın altında gizlənmir.
--
-- Evolution-un cədvəllərinə toxunmur; katibe sxemində yaşayır. Təkrar
-- işlətmək təhlükəsizdir.

CREATE TABLE IF NOT EXISTS katibe.agent_runs (
  id             bigserial PRIMARY KEY,
  agent          text NOT NULL DEFAULT 'nazaratchi',
  trigger        text NOT NULL DEFAULT 'cron',      -- 'cron' | 'manual'
  window_start   timestamptz NOT NULL,
  window_end     timestamptz NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text NOT NULL DEFAULT 'running',   -- 'running' | 'ok' | 'error'
  error          text,
  instance_count int NOT NULL DEFAULT 0,
  finding_count  int NOT NULL DEFAULT 0,
  llm_calls      int NOT NULL DEFAULT 0,
  input_tokens   int NOT NULL DEFAULT 0,
  output_tokens  int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS katibe.agent_posts (
  id               bigserial PRIMARY KEY,
  run_id           bigint NOT NULL REFERENCES katibe.agent_runs(id),
  agent            text NOT NULL DEFAULT 'nazaratchi',
  instance_id      text NOT NULL,
  -- Nömrənin O ANKI sahibi. Tarixi yenidən yazılmasın deyə burada dondurulur:
  -- nömrə sonra başqasına keçsə də, post kimin növbəsində yarandığını deyir.
  user_id          integer REFERENCES katibe.users(id),
  remote_jid       text,                             -- NULL = instans səviyyəli post
  detector         text NOT NULL,                    -- 'unanswered' | 'silence' | ...
  kind             text NOT NULL CHECK (kind IN ('finding', 'all_clear')),
  severity         smallint NOT NULL CHECK (severity BETWEEN 1 AND 10),
  base_severity    smallint NOT NULL CHECK (base_severity BETWEEN 1 AND 10),
  severity_reason  text,                             -- modelin ±2 səbəbi; düzəliş yoxdursa NULL
  verdict          text NOT NULL CHECK (verdict IN ('INTERVENE', 'OK')),
  title            text NOT NULL,
  body             text NOT NULL,
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,
  llm_model        text,                             -- NULL = şablon mətn (model çağırılmayıb/alınmayıb)
  dedupe_key       text NOT NULL,
  times_seen       int NOT NULL DEFAULT 1,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id bigint REFERENCES katibe.agent_runs(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  acknowledged_by  text
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_posts_open_dedupe
  ON katibe.agent_posts (dedupe_key) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_posts_feed_idx
  ON katibe.agent_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_posts_pinned_idx
  ON katibe.agent_posts (severity DESC, created_at DESC) WHERE acknowledged_at IS NULL;
