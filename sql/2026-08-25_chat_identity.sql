-- Kim olduğunu SÖHBƏTİN ÖZÜNDƏN öyrənmək.
--
-- Problem: @lid söhbətlərin 81%-i tamamilə adsızdır — nə etiket, nə pushName,
-- nə nömrə. WhatsApp LID-i nömrəyə çevirmək tələb üzrə mümkün deyil
-- (2026-08-24_lid_number.sql), yəni lentdə "244384343838916@lid 3 saat cavab
-- gözləyir" yazılır və satıcı kimin gözlədiyini bilmir.
--
-- Amma müştəri özü haqqında onsuz da danışır: adını verir, şəhərini deyir,
-- sifariş kodunu yazır. Bu mətn hər saat Haiku-ya ARTIQ göndərilir (hal
-- təsnifatı, chat-state.ts) — ona görə eyni çağırışda bu sahələr də
-- çıxarılır. Əlavə çağırış yoxdur, yalnız bir neçə onluq çıxış tokeni.
--
-- Sətir söhbət başına birdir və İNSTANSDAN ASILI DEYİL: adam eyni adamdır,
-- hansı hesabımızla yazışmasından asılı olmayaraq (contact_labels və
-- lid_number ilə eyni prinsip).
--
-- BU ETİKET DEYİL. contact_labels insanın (və ya identify-clients-in) qərarı,
-- burası isə modelin mətndən oxuduğu İPUCUdur — ona görə ayrı cədvəldir və
-- göstərmə sırasında etiketdən də, tanınmış nömrədən də AŞAĞIDA durur.
CREATE TABLE IF NOT EXISTS katibe.chat_identity (
  remote_jid   text PRIMARY KEY,
  -- Qarşı tərəfin ÖZÜ haqqında dediyi ad (şəxs və ya firma).
  stated_name  text,
  city         text,
  order_code   text,
  -- Yuxarıdakılara sığmayan qısa tanıdıcı detal ("qırmızı Mercedes-lə gələn").
  note         text,
  confidence   text CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  model        text,
  -- Hansı hesabın söhbətindən oxundu — mənbə, əhatə dairəsi yox.
  source_instance_id text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Ad/şəhər/kod ayrı-ayrı söhbətlərdə üzə çıxa bilər, ona görə upsert sahə-sahə
-- COALESCE edir (chat-state.ts) — bir dəfə öyrənilən heç vaxt itmir.
CREATE INDEX IF NOT EXISTS chat_identity_named_idx
  ON katibe.chat_identity (remote_jid) WHERE stated_name IS NOT NULL;
