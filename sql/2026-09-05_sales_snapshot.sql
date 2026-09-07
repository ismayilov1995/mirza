-- Satıcı metriklərinin həftəlik şəkli.
--
-- NİYƏ SAXLAYIRIQ, HALBUKİ HƏR ŞEY YENİDƏN HESABLANA BİLƏR. Bu gün 90 gün
-- geriyə hesablamaq mümkündür — mesajlar anbardadır. Altı ay sonra isə
-- «avqustda necə idi» sualına yalnız saxlanmış şəkil cavab verə bilər, çünki
-- ölçmənin özü dəyişir: SLA qaydası yeni versiya alır, müştəri etiketləri
-- artır, epizod tərifi dəqiqləşir. Keçmişi bugünkü qayda ilə yenidən saymaq
-- «düzəlib» iddiasını mənasız edərdi.
--
-- PAYLOAD JSONB-dir, qəsdən: metrik dəsti zamanla böyüyür (mövzu qarışığı,
-- bayraq statistikası) və hər əlavə üçün migration yazmaq şəkil cədvəlini
-- praktikada dondurardı. Ən çox işlənən üç rəqəm sütun kimi də durur — trend
-- qrafiki JSONB açmadan çəkilsin.
--
-- Təkrar işlətmək təhlükəsizdir.

CREATE TABLE IF NOT EXISTS katibe.sales_snapshot (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES katibe.users(id) ON DELETE CASCADE,
  -- Həftənin bazar ertəsi, Asia/Baku. period_end daxil deyil.
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  payload       jsonb NOT NULL,
  opportunities integer NOT NULL,
  unanswered    integer NOT NULL,
  frt_median    integer,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_snapshot_period_ordered CHECK (period_end > period_start),
  CONSTRAINT sales_snapshot_unique UNIQUE (user_id, period_start)
);

CREATE INDEX IF NOT EXISTS sales_snapshot_period_idx
  ON katibe.sales_snapshot (period_start DESC);

ALTER TABLE katibe.sales_snapshot OWNER TO evolution;
