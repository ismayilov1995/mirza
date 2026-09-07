-- Nəzarətçi yalnız müştəri dairəsinə baxır (Client + hələ kateqoriyasızlar).
-- Dairədən kənara düşən AÇIQ bayraqlar avtomatik bağlanır, amma 'AUTO'
-- deyil: 'AUTO' "problem həll olundu" deməkdir, bu isə "bu söhbət artıq
-- nəzarətçinin mövzusu deyil". İkisini eyni sözlə yazsaq, lentdə cavabsız
-- qalmış söhbət həll olunmuş kimi görünərdi.
ALTER TABLE katibe.agent_posts
  DROP CONSTRAINT IF EXISTS agent_posts_closed_reason_check;

ALTER TABLE katibe.agent_posts
  ADD CONSTRAINT agent_posts_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN ('MANUAL', 'AUTO', 'SCOPE'));
