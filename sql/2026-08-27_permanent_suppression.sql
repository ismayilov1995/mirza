-- «Bir daha göstərmə» — DAİMİ susdurma.
--
-- Reytinq 1 (RATED_NOISE) 30 günlük susdurma açır və üç klapan saxlayır:
-- müddət, bal eskalasiyası, modelin «vəziyyət dəyişib» rəyi. Praktikada
-- üçüncüsü menecerin qərarını ləğv edirdi. Telefonda bağlanmış sifariş
-- söhbətində müştərinin son mesajı həmişə «top bizim tərəfdədir» kimi oxunur
-- (ünvanını yazıb, izləmə nömrəsi gözləyir) — Sonnet hər gedişatda
-- sameAsDismissed=false qaytarırdı. 207907253661864 üçün jurnalda üç ardıcıl
-- DIFFERENT sətri var; menecer eyni bayrağa üç dəfə 1 verdi, üçündən sonra da
-- bayraq geri qayıtdı. Düymə çarəsiz görünəndə adam düyməyə inanmağı dayandırır.
--
-- Daimi susdurma məhz bu boşluq üçündür və klapanların HAMISINI bağlayır:
-- müddəti yoxdur (expires_at NULL), eskalasiya keçmir, model rəyi ümumiyyətlə
-- soruşulmur (yəni pul da xərclənmir). Onu yalnız insan ləğv edə bilər —
-- /admin/suppressions → «Yenidən göstər».
--
-- Auditdən ÇIXMIR: hər gizlətmə eynilə agent_suppression_log-a düşür, ona görə
-- «vacib bir şey sırf bu düyməyə görə itdi?» sualının cavab yeri yerindədir.
--
-- Söhbətin TARİXÇƏSİNƏ toxunmur: mesajlar, statistika, təhlil — hamısı olduğu
-- kimi qalır. Susdurulan yalnız həmin söhbətdəki HƏMİN növ bayraqdır.

ALTER TABLE katibe.agent_suppressions
  ADD COLUMN IF NOT EXISTS permanent boolean NOT NULL DEFAULT false;

-- Daimi sətirdə son istifadə tarixi olmamalıdır. Onu «çox uzaq tarix» ilə
-- doldurmaq daha qısa olardı, amma o zaman audit səhifəsi mənasız bir tarix
-- göstərərdi və «bu susdurma nə vaxt bitir?» sualı yanlış cavab alardı.
ALTER TABLE katibe.agent_suppressions
  ALTER COLUMN expires_at DROP NOT NULL;

-- İki sahə bir-birini təkrarlamır, bir-birini bağlayır: müddətsiz sətir
-- daimidir, daimi sətrin müddəti yoxdur. Kod tərəfdə unudulan hal buradan
-- xəta kimi qayıdır, səssiz «heç vaxt bitməyən 30 gün» kimi yox.
ALTER TABLE katibe.agent_suppressions
  DROP CONSTRAINT IF EXISTS agent_suppressions_expiry_check;
ALTER TABLE katibe.agent_suppressions
  ADD CONSTRAINT agent_suppressions_expiry_check
  CHECK (permanent = (expires_at IS NULL));

-- Bağlanma səbəbi ayrıdır: 'RATED_NOISE' «bu bayraq olmamalıydı» deməkdir və
-- datasetə düşür, 'MUTED' isə «bayraq düz idi, iş başqa kanalda bitdi» —
-- modelə nümunə kimi göstərilməməlidir.
ALTER TABLE katibe.agent_posts
  DROP CONSTRAINT IF EXISTS agent_posts_closed_reason_check;
ALTER TABLE katibe.agent_posts
  ADD CONSTRAINT agent_posts_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN
    ('MANUAL', 'AUTO', 'SCOPE', 'RATED_NOISE', 'HANDOFF', 'MUTED'));
