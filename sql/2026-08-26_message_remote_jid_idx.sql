-- Söhbət başına mesaj sayını indekslə oxumaq üçün ifadə indeksi.
--
-- Təklif ekranı ("/admin/suggestions") hər açılışda iki dəfə "bu nömrələrin
-- neçə mesajı var?" soruşur. Sual `key->>'remoteJid'` üzərindən gedir, o isə
-- yalnız `Message_instanceId_remoteJid_ts_idx`-in İKİNCİ sütunudur — instans
-- verilmədikdə indeks işə düşmür və Postgres 254 min sətri baştan-başa
-- oxuyurdu (hər sorğu ~210 ms, cəmi ~450 ms). "Client et" düyməsi məhz buna
-- görə gec cavab verirdi: hərəkət özü tez bitir, vaxtın çoxu ondan sonrakı
-- yenidən çəkilişə gedir.
--
-- İndekslə eyni sorğular ~50 ms-ə düşür. Sorğular da `IN (SELECT ...)`-dan
-- `= ANY (ARRAY(SELECT ...))`-a keçirilib: birincisi hash semi-join qurub
-- indeksi tamam görmür.
--
-- DİQQƏT: bu, katibe deyil, evolution_api sxeminə yazır — Evolution API-nin
-- öz cədvəlinə əlavə indeksdir (əvvəlki əl ilə qoyulmuş indekslərlə eyni
-- cərgədə). Yazma əməliyyatlarını kilidləməmək üçün CONCURRENTLY. Təkrar
-- işlətmək təhlükəsizdir; geri almaq üçün sadəcə DROP INDEX.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_remoteJid_idx"
  ON evolution_api."Message" (((key ->> 'remoteJid')));
