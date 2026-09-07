-- İki yeni söhbət halı: "Dubaya yönləndirilib" və "PR üçün".
--
-- Hər ikisi eyni problemi həll edir və hər ikisi BAYRAQ MÖVZUSU DEYİL:
--
--   FORWARDED_TO_DUBAI — biz müştəriyə "Dubay komandası sizinlə əlaqə
--     saxlayacaq" demişik. Top artıq bizim filialda deyil, ona görə "N saatdır
--     cavabsız" ölçüsü mənasını itirir: burada cavab verəcək adam yoxdur.
--     Nəzarətçi bunları saatlarla 9 balla bayraqlayırdı (doğrulama qatı
--     onları tuturdu, amma yalnız MEDIUM əminliklə — yəni bal düşmürdü).
--
--   FOR_PR — qarşı tərəf ümumiyyətlə müştəri deyil: əməkdaşlıq, reklam,
--     blogger/influencer təklifi ("we want to cooperate with you"). Satış
--     SLA-sı ilə ölçülməsi səhvdir.
--
-- HAL, ETİKET DEYİL — qəsdən. katibe.contact_labels-dəki PR kateqoriyası
-- adamın KİM olduğunu deyir və insan qoyur; bunlar isə söhbətin İNDİ hansı
-- vəziyyətdə olduğunu deyir və mətndən oxunur. Dubaya yönləndirilmiş müştəri
-- sabah yeni sifarişlə qayıda bilər: təzə mesaj gələn kimi hal yenidən
-- hesablanır və söhbət öz-özünə nəzarətə qayıdır. Etiket olsaydı, əbədi
-- susardı.
--
-- Təkrar işlətmək təhlükəsizdir.

ALTER TABLE katibe.chat_state
  DROP CONSTRAINT IF EXISTS chat_state_state_check;
ALTER TABLE katibe.chat_state
  ADD CONSTRAINT chat_state_state_check
  CHECK (state IN (
    'WAITING_ON_US', 'CUSTOMER_DECIDING', 'IN_PROGRESS', 'RESOLVED',
    'FILLER', 'STALE', 'FORWARDED_TO_DUBAI', 'FOR_PR'
  ));

-- Bu hallara düşən söhbətlərin açıq bayraqları bağlanır. Səbəb ayrıcadır:
-- 'AUTO' "satıcı cavab verdi" deməkdir və sübut tələb edir, 'SCOPE' isə
-- kateqoriya dəyişikliyidir. Burada isə heç biri baş vermir — iş sadəcə
-- başqa yerə keçib.
ALTER TABLE katibe.agent_posts
  DROP CONSTRAINT IF EXISTS agent_posts_closed_reason_check;
ALTER TABLE katibe.agent_posts
  ADD CONSTRAINT agent_posts_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN
    ('MANUAL', 'AUTO', 'SCOPE', 'RATED_NOISE', 'HANDOFF'));

-- Yönləndirilmişlər səhifəsi hal + vaxt üzrə sıralayır, instansa görə yox
-- (bir adam bir neçə nömrəyə baxa bilər).
CREATE INDEX IF NOT EXISTS chat_state_handoff_idx
  ON katibe.chat_state (state, classified_at DESC)
  WHERE state IN ('FORWARDED_TO_DUBAI', 'FOR_PR');
