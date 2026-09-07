-- Postun bağlanma səbəbi: insan bağladı, yoxsa problem öz-özünə aradan qalxdı.
--
-- Əvvəl yalnız acknowledged_at vardı və o, "admin düyməni basdı" demək idi.
-- Amma bayraqların çoxu insan toxunmadan həll olunur: satıcı cavab verir və
-- tapıntı növbəti gedişatda ümumiyyətlə görünmür. O postlar lentdə qırmızı
-- qalırdı — yəni lent həll olunmuş problemləri göstərməkdə davam edirdi.
--
-- İndi hər bağlanmanın səbəbi var: MANUAL (admin "Həll edildi" basdı) və ya
-- AUTO (tapıntı artıq detektorun nəticəsində yoxdur). Hər ikisi eyni sütunla
-- (acknowledged_at) bağlanır, ona görə dedupe indeksi olduğu kimi qalır:
-- bağlanan postun açarı azad olur, problem qayıdarsa TƏZƏ post açılır.
--
-- Təkrar işlətmək təhlükəsizdir.

ALTER TABLE katibe.agent_posts
  ADD COLUMN IF NOT EXISTS closed_reason text;

ALTER TABLE katibe.agent_posts
  DROP CONSTRAINT IF EXISTS agent_posts_closed_reason_check;
ALTER TABLE katibe.agent_posts
  ADD CONSTRAINT agent_posts_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN ('MANUAL', 'AUTO'));

-- Miqrasiyadan əvvəl bağlanmış hər şey əl ilə bağlanmışdı.
UPDATE katibe.agent_posts
SET closed_reason = 'MANUAL'
WHERE acknowledged_at IS NOT NULL AND closed_reason IS NULL;

-- Bağlananlar cədvəli "ən son bağlanan üstdə" sıralanır.
CREATE INDEX IF NOT EXISTS agent_posts_closed_idx
  ON katibe.agent_posts (acknowledged_at DESC) WHERE acknowledged_at IS NOT NULL;
