-- Açıq intent bayraqlarına bağlanma sübutu.
--
-- autoCloseMissing (persist.ts) söhbətə bağlı bayrağı yalnız evidence-dəki
-- lastInboundTs-dən SONRA bizdən mesaj getdiyini görəndə bağlayır. intent
-- detektoru həmin sahəni heç vaxt yazmırdı, yəni onun bayraqları avtomatik
-- bağlana BİLMİRDİ: 30 günlük ölçmədə 24 intent postundan 19-u lentdə açıq
-- qalmışdı, halbuki söhbətlərin çoxunda iş çoxdan bitmişdi.
--
-- Kod artıq sahəni yazır (intent.ts). Bu miqrasiya isə ARTIQ AÇIQ olanlara
-- həmin sahəni verir — köhnə sıralar da adi qaydaya qoşulsun deyə.
--
-- HEÇ NƏ BAĞLAMIR. Yalnız sübut sahəsi əlavə olunur; bağlayıb-bağlamamağa
-- adi qayda özü qərar verəcək. Üstəlik ən EHTİYATLI qiymət yazılır — son
-- gələn mesajın vaxtı: bu, hadisənin öz anından yeni ola bilər, yəni bayraq
-- bağlanmaq üçün daha təzə cavab tələb edəcək.
--
-- Təkrar işlətmək təhlükəsizdir.

UPDATE katibe.agent_posts p
   SET evidence = p.evidence || jsonb_build_object('lastInboundTs', li.ts)
  FROM (
    SELECT p2.id,
           (SELECT MAX(m."messageTimestamp")
              FROM evolution_api."Message" m
             WHERE m."instanceId" = p2.instance_id
               AND m.key->>'remoteJid' = p2.remote_jid
               AND NOT (m.key->>'fromMe')::boolean
               AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')) AS ts
      FROM katibe.agent_posts p2
     WHERE p2.detector = 'intent'
       AND p2.acknowledged_at IS NULL
       AND p2.remote_jid IS NOT NULL
       AND (p2.evidence->>'lastInboundTs') IS NULL
  ) li
 WHERE p.id = li.id AND li.ts IS NOT NULL;
