-- İnstansın qoşulma tarixçəsi: nə vaxt qopdu, nə vaxt qayıtdı.
--
-- Niyə ayrıca cədvəl: Evolution-un "Instance" sətri yalnız İNDİKİ vəziyyəti
-- bilir. Nəzarətçiyə isə iki əlavə fakt lazımdır və ikisi də tarixçədir:
--
--   down_since       — qopma NƏ VAXT başladı. Qayıdışdan sonra bayraqları
--                      hansı pəncərədən yenidən yoxlamaq lazım olduğunu bu
--                      deyir. ("disconnectionAt" sütunu var, amma Evolution
--                      onu yalnız bəzi qopma yollarında doldurur.)
--   revalidate_from  — "bu instans qopmadan qayıdıb, bayraqları hələ təzədən
--                      yoxlanılmayıb" nişanı. Gedişat onu görüb pəncərəni
--                      qopma anına qədər geri açır, işini bitirəndə silir.
--                      Nişan bazada durduğu üçün gedişat buraxılsa da,
--                      kilidə düşsə də itmir.
--
-- Bunu bilmədən nəzarətçi ölü instansın donmuş məlumatı üzərində işləyirdi:
-- satıcı telefondan cavab yazır, baza görmür, "cavabsız" bayrağı saatlarla
-- böyüyür (2026-08-25, Rouz və Rouz-2 — dörd saat).
--
-- Yalnız katibe sxeminə yazır. Təkrar işlətmək təhlükəsizdir.

CREATE TABLE IF NOT EXISTS katibe.instance_connectivity (
  instance_id     text PRIMARY KEY,
  -- Evolution-un son baxışdakı connectionStatus dəyəri ('open', 'connecting', 'close').
  status          text NOT NULL,
  -- Statusun DƏYİŞDİYİ an — qayıdış anı da budur (status 'open' olanda).
  changed_at      timestamptz NOT NULL DEFAULT now(),
  checked_at      timestamptz NOT NULL DEFAULT now(),
  -- Açıq qopmanın başlanğıcı; instans qoşulu ikən NULL.
  down_since      timestamptz,
  -- Qayıdışdan sonra yenidən yoxlanmalı pəncərənin başlanğıcı; yoxlanandan sonra NULL.
  revalidate_from timestamptz
);

CREATE INDEX IF NOT EXISTS instance_connectivity_revalidate_idx
  ON katibe.instance_connectivity (instance_id) WHERE revalidate_from IS NOT NULL;
