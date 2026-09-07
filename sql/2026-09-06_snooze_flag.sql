-- MÖHLƏT — «bilirəm, mənə 3 gün ver», sonra hesabat.
--
-- Lentdə bayrağı gözdən çıxaran üç düymə var idi və heç biri bu işi görmürdü:
--
--   «Həll edildi»        → problem davam edirsə növbəti gedişatda geri qayıdır.
--                          Menecer «çatdırılmanı gözləyirik» deyəndə bayraq bir
--                          saat sonra yenidən qırmızı olurdu.
--   Reytinq 1 «Lazımsız» → 30 gün susdurur, AMMA datasetə «bu bayraq səhv idi»
--                          nümunəsi kimi düşür. Bayraq düz idi; səhv olan
--                          yalnız VAXT idi.
--   «Bir daha göstərmə»  → həmişəlik. Üç günlük gözləmə üçün çox ağırdır və
--                          bitəndə heç kim xəbər vermir.
--
-- Möhlət dördüncüsüdür və yeganə olan cəhəti odur ki, ÖZÜ QAYIDIR: müddət
-- bitəndə problem hələ də davam edirsə bayraq «3 gün möhlət verilmişdi —
-- problem davam edir» nişanı və +1 balla lentə çıxır; həll olubsa heç nə
-- görünmür. Yəni möhlət «unutmaq» deyil, təyin olunmuş tarixə söz vermək.
--
-- KLAPANLAR. Daimi susdurmadan fərqli olaraq eskalasiya klapanı AÇIQ qalır:
-- möhlət müddətində bal 2 vahid qalxsa bayraq dərhal qayıdır — möhlət «heç
-- vaxt göstərmə» demək deyil. Model rəyi isə soruşulmur: «vəziyyət dəyişib?»
-- sualı hər gedişatda pul yandırır və menecerin öz verdiyi möhləti ləğv edir
-- (2026-08-27 qeydindəki eyni səbəb).

-- 1. SUSDURMA SƏTRİ ------------------------------------------------------

-- `snooze_days` iki işi bir yerdə görür: sətrin möhlət olduğunu bildirir
-- (NULL = adi susdurma) və bitəndə yazılacaq mətn üçün «neçə gün söz
-- verilmişdi» rəqəmini saxlayır. Onu expires_at - created_at fərqindən geri
-- hesablamaq olardı, amma müddət təqvim gününə (səhər 09:00) yuvarlaqlaşdığı
-- üçün fərq heç vaxt tam gün olmur və «2.6 gün möhlət» yazan ekran çıxardı.
ALTER TABLE katibe.agent_suppressions
  ADD COLUMN IF NOT EXISTS snooze_days smallint;

-- Möhlətin müddəti VAR — daimi ola bilməz. Bu şərt olmasa «müddətsiz möhlət»
-- yazmaq mümkün olardı, o isə adı ilə birlikdə mənasını da itirir.
ALTER TABLE katibe.agent_suppressions
  DROP CONSTRAINT IF EXISTS agent_suppressions_snooze_check;
ALTER TABLE katibe.agent_suppressions
  ADD CONSTRAINT agent_suppressions_snooze_check
  CHECK (snooze_days IS NULL OR (snooze_days BETWEEN 1 AND 30 AND NOT permanent));

-- Möhlət bitdi — nəticə hesabatı verildimi?
--
-- Müddəti bitən sətir loadActiveSuppressions() tərəfindən ləğv olunur, amma
-- ləğv özü hesabat deyil: «problem davam edir» yalnız növbəti gedişatda bayraq
-- HƏQİQƏTƏN qayıdanda bilinir. Bu sahə həmin gözləmə anını tutur: NULL =
-- nəticə hələ yazılmayıb, dolu = yazıldı (SNOOZE_BROKEN və ya SNOOZE_KEPT).
-- Onsuz eyni möhlət hər gedişatda yenidən «pozuldu» kimi oxunardı.
ALTER TABLE katibe.agent_suppressions
  ADD COLUMN IF NOT EXISTS snooze_reported_at timestamptz;

-- Nəticəsi gözlənilən möhlətlər hər gedişatda, hər instans üçün axtarılır.
-- Say kiçikdir, amma sorğu tez-tezdir və şərt seçicidir — qismən indeks.
CREATE INDEX IF NOT EXISTS agent_suppressions_snooze_pending_idx
  ON katibe.agent_suppressions (agent, instance_id)
  WHERE snooze_days IS NOT NULL AND snooze_reported_at IS NULL;

-- 2. POST ---------------------------------------------------------------

-- Möhlət VERİLMİŞ post (bağlanmış): neçə gün və hansı ana qədər.
-- Zolaqda «3 gün möhlət — 9 sen 09:00-dək» yazılır; tarixsiz variant
-- «möhlət verildi» deyib nə vaxt bitdiyini gizlədərdi, halbuki menecerin
-- növbəti sualı elə budur.
ALTER TABLE katibe.agent_posts
  ADD COLUMN IF NOT EXISTS snooze_days smallint;
ALTER TABLE katibe.agent_posts
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;

-- Möhlətdən SONRA qayıtmış post (açıq): möhlət neçə gün idi.
--
-- Ayrı sahədir, `snooze_days`-ın təkrarı deyil — bu, BAŞQA postdur. Möhlət
-- verilən post bağlanır və olduğu yerdə qalır; qayıdan isə təzə sətirdir və
-- onun üzərindəki rəqəm «sənə nə qədər vaxt verilmişdi» deməkdir, «nə qədər
-- vaxt verildi» yox. İki mənanı bir sütuna yığmaq lentdə eyni rəqəmi iki cür
-- oxumaq tələb edərdi.
ALTER TABLE katibe.agent_posts
  ADD COLUMN IF NOT EXISTS after_snooze_days smallint;

-- Bağlanma səbəbi ayrıdır və qəsdən: 'SNOOZED' nə 'MANUAL' (həll etdim), nə
-- 'RATED_NOISE' (bu bayraq olmamalıydı), nə də 'MUTED' (iş başqa kanalda
-- bitdi) deməkdir. Üçü ilə qarışsa, «möhlət verib unutduğum neçə iş var»
-- sualına cavab verən sorğu yazmaq mümkün olmazdı.
ALTER TABLE katibe.agent_posts
  DROP CONSTRAINT IF EXISTS agent_posts_closed_reason_check;
ALTER TABLE katibe.agent_posts
  ADD CONSTRAINT agent_posts_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN
    ('MANUAL', 'AUTO', 'SCOPE', 'RATED_NOISE', 'HANDOFF', 'MUTED', 'SNOOZED'));

-- 3. AUDİT JURNALI ------------------------------------------------------

-- İki yeni nəticə. Möhlətin bütün dəyəri onun bitişindədir, ona görə bitiş
-- jurnalda ayrıca oxunmalıdır:
--   SNOOZE_BROKEN — müddət bitdi, problem davam edir, bayraq geri çıxdı.
--   SNOOZE_KEPT   — müddət bitdi, problem qayıtmadı; möhlət öz işini gördü.
-- İkincisi «heç nə olmadı» sətridir və məhz ona görə lazımdır: onsuz jurnalda
-- yalnız uğursuz möhlətlər görünərdi və düymə olduğundan pis görünərdi.
ALTER TABLE katibe.agent_suppression_log
  DROP CONSTRAINT IF EXISTS agent_suppression_log_outcome_check;
ALTER TABLE katibe.agent_suppression_log
  ADD CONSTRAINT agent_suppression_log_outcome_check
  CHECK (outcome IN ('SUPPRESSED', 'ESCALATED', 'DIFFERENT', 'EXPIRED',
                     'SNOOZE_BROKEN', 'SNOOZE_KEPT'));
