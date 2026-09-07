-- Mövzu təsnifatı kanonik anbara köçür.
--
-- KÖHNƏ CƏDVƏL TƏRK EDİLMİŞDİ. katibe.message_topic-də 8 289 sətir var,
-- hamısı principal hesabınındır və sonuncusu 2026-08-24 tarixlidir; onu dolduran
-- skript nə repoda, nə də crontab-dadır. Yəni qat bir dəfə qurulub və
-- saxlanılmayıb. Satıcılar üçün bir dənə də sətri yoxdur.
--
-- Yeni cədvəl evolution_api."Message"-ə yox, katibe.message-ə bağlanır: mövzu
-- statistikanın qalanı ilə eyni anbardan oxunmalıdır, yoxsa arxivdən gələn
-- mesajın mövzusu heç vaxt olmaz.
--
-- Köhnəsi SİLİNMİR, adı dəyişir: principal-ın datası zərərsizdir və nə vaxtsa
-- müqayisə üçün lazım ola bilər. Kodda ona bir istinad yoxdur (yalnız bir
-- şərhdə adı çəkilir).

ALTER TABLE IF EXISTS katibe.message_topic RENAME TO message_topic_legacy;

CREATE TABLE IF NOT EXISTS katibe.message_topic (
  message_id    bigint PRIMARY KEY REFERENCES katibe.message(id) ON DELETE CASCADE,
  -- Etiket dəsti köhnə ilə EYNİDİR ki, köhnə data ilə müqayisə mümkün qalsın.
  topic         text NOT NULL CHECK (topic IN (
    'GENERAL','PRODUCT_INFO','ORDER','LOGISTICS','PAYMENT','PRICE_INQUIRY','COMPLAINT'
  )),
  -- Hansı model yazıb: model dəyişəndə köhnə etiketlərin haradan gəldiyi
  -- bilinməlidir, yoxsa keyfiyyət fərqi mövzu trendi kimi oxunar.
  model         text NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now()
);

-- İndeks adı qəsdən yenidir: cədvəl adı dəyişəndə onun indeksləri KÖHNƏ adla
-- qalır, ona görə `message_topic_topic_idx` artıq legacy cədvəlin üstündədir və
-- eyni adla ikincisi yaradıla bilmir (IF NOT EXISTS onu səssizcə atlayır).
CREATE INDEX IF NOT EXISTS message_topic_v2_topic_idx ON katibe.message_topic (topic);

ALTER TABLE katibe.message_topic OWNER TO evolution;
