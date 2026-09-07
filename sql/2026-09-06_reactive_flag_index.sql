-- Söhbətin AÇIQ bayraqlarına birbaşa yol.
--
-- Satıcı cavab yazan kimi vebhuk həmin söhbətin bayraqlarını yoxlayır
-- (src/lib/supervisor/reactive.ts) — yəni bu sorğu artıq saatda bir yox,
-- HƏR gedən mesajda işləyir. Onsuz axtarış cədvəli tam gəzərdi: bayraq
-- olmayan söhbətlərdə (mesajların böyük əksəriyyəti) boş yerə.
--
-- İndeks qismidir və dar: yalnız açıq tapıntılar. Bağlanmış postlar zamanla
-- yığılır, amma bu suala heç vaxt cavab olmurlar. Eyni səbəbdən
-- agent_posts_open_dedupe də qismidir.
--
-- Təkrar işlətmək təhlükəsizdir.

CREATE INDEX IF NOT EXISTS agent_posts_open_chat_idx
  ON katibe.agent_posts (instance_id, remote_jid)
  WHERE acknowledged_at IS NULL AND kind = 'finding';
