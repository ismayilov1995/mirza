-- Yenidən qoşulan iki nömrənin tarixçəsini köhnə instansdan yenisinə köçürür.
--
-- 2026-08-26-da Rouz və Rouz-2 instansları silinib yenidən qoşuldu (Rouz-219,
-- Rouz-51313). Evolution yeni instansa öz ID-sini verir və tarixçəni sıfırdan
-- sinxronlaşdırır — WhatsApp isə hər şeyi geri vermir:
--
--   Rouz    → Rouz-219    : 5 218 mesaj YALNIZ köhnədə qalıb
--   Rouz-2  → Rouz-51313  : 17 197 mesaj YALNIZ köhnədə qalıb
--
-- Köhnə sətri sadəcə silmək 22 415 mesajı həmişəlik aparardı (evolution_api
-- nüsxələnmir — gecəlik backup yalnız katibe sxemidir), üstəlik həmin
-- nömrələrə bağlı bütün katibe metadatası — AI-ın çıxardığı kimliklər, söhbət
-- halları, təkliflər, səs transkriptləri — ölü instans ID-sinə baxıb lentdən
-- yoxa çıxardı.
--
-- Ona görə silmədən ƏVVƏL: köhnədə TƏK olan hər şey yeni instansa keçir,
-- köhnədə qalan yalnız təkrarlar olur. Sonra instansı Evolution-un öz API-si
-- silir (DELETE /instance/delete/<ad>) — sətri birbaşa bazadan silmək işləyən
-- servisin arxasınca getmək olardı.
--
-- Nömrə eyni nömrədir, sahibi eyni adamdır: tarixçənin yeni instansın altına
-- keçməsi statistikanı dəyişmir, sadəcə bütövləşdirir.
--
-- Bir dəfəlik köçürmədir; təkrar işlədilsə heç nə tapmayıb sakitcə çıxır.

BEGIN;

CREATE TEMP TABLE pair(old text, new text) ON COMMIT DROP;
INSERT INTO pair VALUES
  ('224b8867-fae0-4762-abed-d62738249563', 'c7be87e8-92ca-441f-988f-55ecedf02dc5'), -- Rouz    → Rouz-219
  ('5532ff40-83f9-4f87-ac7c-7bede7064f19', 'dae2e0f1-2d86-42ac-bf57-e7f72048c19e'); -- Rouz-2  → Rouz-51313

-- 1. Yalnız köhnədə olan mesajlar. Unikallıq (instanceId, key->>'id')
--    üzərindədir, müqayisə də elə onunla gedir.
UPDATE evolution_api."Message" m
SET "instanceId" = p.new
FROM pair p
WHERE m."instanceId" = p.old
  AND NOT EXISTS (
    SELECT 1 FROM evolution_api."Message" b
    WHERE b."instanceId" = p.new AND b.key->>'id' = m.key->>'id'
  );

-- 2. Media və status yeniləmələri mesajın ardınca gedir: onların da
--    instanceId-si var və köhnə instans silinəndə CASCADE onları aparardı.
UPDATE evolution_api."Media" md
SET "instanceId" = m."instanceId"
FROM evolution_api."Message" m, pair p
WHERE md."messageId" = m.id AND md."instanceId" = p.old AND m."instanceId" = p.new;

UPDATE evolution_api."MessageUpdate" mu
SET "instanceId" = m."instanceId"
FROM evolution_api."Message" m, pair p
WHERE mu."messageId" = m.id AND mu."instanceId" = p.old AND m."instanceId" = p.new;

-- 3. Söhbət/kontakt/etiket sətirləri — yenidə olmayanlar keçir.
UPDATE evolution_api."Chat" c
SET "instanceId" = p.new
FROM pair p
WHERE c."instanceId" = p.old
  AND NOT EXISTS (SELECT 1 FROM evolution_api."Chat" b
                  WHERE b."instanceId" = p.new AND b."remoteJid" = c."remoteJid");

UPDATE evolution_api."Contact" ct
SET "instanceId" = p.new
FROM pair p
WHERE ct."instanceId" = p.old
  AND NOT EXISTS (SELECT 1 FROM evolution_api."Contact" b
                  WHERE b."instanceId" = p.new AND b."remoteJid" = ct."remoteJid");

UPDATE evolution_api."Label" l
SET "instanceId" = p.new
FROM pair p
WHERE l."instanceId" = p.old
  AND NOT EXISTS (SELECT 1 FROM evolution_api."Label" b
                  WHERE b."instanceId" = p.new AND b."labelId" = l."labelId");

-- 4. Səs transkriptləri mesajın ID-sinə bağlıdır (FK, ON DELETE CASCADE).
--    Bu mərhələdə köhnədə qalan mesaj = təkrar, deməli transkript silinəcək
--    sətrə baxır. Onu yenidəki əkizinə bağlayırıq — pulu ödənmiş mətn itməsin.
UPDATE katibe.voice_transcript v
SET message_id = twin.id, instance_id = p.new
FROM evolution_api."Message" m
JOIN pair p ON m."instanceId" = p.old
JOIN evolution_api."Message" twin
  ON twin."instanceId" = p.new AND twin.key->>'id' = m.key->>'id'
WHERE v.message_id = m.id
  AND NOT EXISTS (SELECT 1 FROM katibe.voice_transcript v2 WHERE v2.message_id = twin.id);

-- Əkizin öz transkripti varsa köhnəsi sadəcə təkrardır.
DELETE FROM katibe.voice_transcript v
USING evolution_api."Message" m, pair p
WHERE v.message_id = m.id AND m."instanceId" = p.old;

-- 5. Katibe metadatası. Bunların çoxu remote_jid ilə açarlanır, yəni instansdan
--    asılı deyil — sadəcə instans sütunu yenilənir.
UPDATE katibe.chat_identity   SET source_instance_id = p.new FROM pair p WHERE source_instance_id = p.old;
UPDATE katibe.chat_suggestion SET instance_id = p.new FROM pair p WHERE instance_id = p.old;
UPDATE katibe.lid_number      SET instance_id = p.new FROM pair p WHERE instance_id = p.old;
UPDATE katibe.chat_summary    SET instance_id = p.new FROM pair p WHERE instance_id = p.old;
UPDATE katibe.chat_question   SET instance_id = p.new FROM pair p WHERE instance_id = p.old;

-- chat_state açarı (instance_id, remote_jid): yenidə eyni söhbət varsa, o
-- daha təzədir — köhnəsi atılır.
DELETE FROM katibe.chat_state s
USING pair p
WHERE s.instance_id = p.old
  AND EXISTS (SELECT 1 FROM katibe.chat_state n
              WHERE n.instance_id = p.new AND n.remote_jid = s.remote_jid);
UPDATE katibe.chat_state SET instance_id = p.new FROM pair p WHERE instance_id = p.old;

-- agent_posts: dedupe açarının içində instans ID-si var, ona görə açar da
-- yenilənir — yoxsa nəzarətçi eyni problemi TƏZƏ post kimi yenidən açardı.
-- Açıq postlarda toqquşma olarsa, yenininki qalır.
DELETE FROM katibe.agent_posts a
USING pair p
WHERE a.instance_id = p.old AND a.acknowledged_at IS NULL
  AND EXISTS (SELECT 1 FROM katibe.agent_posts b
              WHERE b.dedupe_key = replace(a.dedupe_key, p.old, p.new)
                AND b.acknowledged_at IS NULL);
UPDATE katibe.agent_posts a
SET instance_id = p.new, dedupe_key = replace(a.dedupe_key, p.old, p.new)
FROM pair p WHERE a.instance_id = p.old;

-- Bağlantı tarixçəsi: yeni instansın öz sətri var, köhnəsi mənasız qalır.
DELETE FROM katibe.instance_connectivity c USING pair p WHERE c.instance_id = p.old;

COMMIT;
