-- Satıcı faktları: modelin yazdığı cümlələr və onların altındakı rəqəmlər.
--
-- QAYDA: RƏQƏM KODDAN, CÜMLƏ MODELDƏN. Nəzarətçidə severity iki sütundur
-- (base_severity düsturdan, severity modeldən) məhz buna görə; burada da eyni
-- şəkil: `evidence` cümlədəki hər rəqəmi saxlayır, `direction` isə kodda
-- hesablanır. Model «düzəlib» yaza bilər, amma düzəlib-düzəlmədiyini o
-- qərarlaşdırmır — «düzəlib» ölçülə bilən iddiadır.
--
-- UNIQUE (period_start, user_id, kind): bir dövr üçün eyni növdə iki fakt
-- olmur. Gedişat təkrarlansa, fakt yerində yenilənir — lent zibillənmir.

CREATE TABLE IF NOT EXISTS katibe.sales_insight (
  id           bigserial PRIMARY KEY,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  -- NULL = komanda haqqında ümumi fakt.
  user_id      integer REFERENCES katibe.users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('difference','flag','hours','topic','weekend')),
  headline     text NOT NULL,
  body         text NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- «Nədən çıxdı» sətri: faktın altındakı quru rəqəm cümləsi, modelə verildiyi
  -- kimi. Ekranda cümlənin yanında durur — model uydursa, fərq görünür.
  basis        text NOT NULL DEFAULT '',
  direction    text CHECK (direction IN ('better','worse','flat','new')),
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- user_id NULL ola bildiyi üçün adi UNIQUE işləmir (NULL-lar bir-birinə
-- bərabər sayılmır) — iki qismən indeks eyni işi düz görür.
CREATE UNIQUE INDEX IF NOT EXISTS sales_insight_user_key
  ON katibe.sales_insight (period_start, user_id, kind) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sales_insight_team_key
  ON katibe.sales_insight (period_start, kind) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS sales_insight_period_idx
  ON katibe.sales_insight (period_start DESC);

CREATE TABLE IF NOT EXISTS katibe.sales_insight_translation (
  insight_id bigint NOT NULL REFERENCES katibe.sales_insight(id) ON DELETE CASCADE,
  lang       text NOT NULL,
  headline   text NOT NULL,
  body       text NOT NULL,
  basis      text NOT NULL DEFAULT '',
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (insight_id, lang)
);

ALTER TABLE katibe.sales_insight OWNER TO evolution;
ALTER TABLE katibe.sales_insight_translation OWNER TO evolution;
