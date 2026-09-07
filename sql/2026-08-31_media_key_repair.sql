-- Evolution medialarının obyekt açarını düzəldir.
--
-- NƏ İDİ. Anbara köçürülən 2 103 media sətrinin HAMISI oxunmurdu: söhbətdə
-- şəkil, stiker və sənədlərin yerində sınıq ikon və fayl adı görünürdü.
-- Səbəb açarın özündə idi — köçürmə onu Evolution-un presigned URL-indən
-- kəsib götürür və iki şeyi nəzərə almırdı:
--
--   1. YOL ÜSLUBU. Ünvan `https://fra1.digitaloceanspaces.com/katibe/…`
--      formasındadır, yəni yolun BİRİNCİ hissəsi bucket adıdır. Sxem və host
--      atılanda açarın başında «katibe/» qalırdı və S3-ə «katibe» bucket-ində
--      «katibe/…» açarı soruşulurdu.
--   2. KODLAŞDIRMA. URL-də JID-dəki `@` işarəsi `%40`, boşluq `%20`, `İ` isə
--      `%C4%B0` kimi yazılır. Həqiqi açarda isə onlar olduğu kimidir.
--
-- Yalnız hər ikisi düzələndə fayl oxunur (ölçüldü: 106 029 bayt).
--
-- Arxiv mediaları (239 050 sətir) toxunulmur: onların açarı ixracdan gəlir,
-- kodlaşdırılmayıb və onsuz da oxunur.
--
-- TƏKRAR OLMAYACAQ: scripts/mirror-evolution.ts artıq açarı düzgün yazır
-- (bucket kəsilir, kodlaşdırma açılır). Bu fayl yalnız köhnə sətirləri düzəldir.

BEGIN;

/*
 * Faiz kodlaşdırmasını açan funksiya.
 *
 * Postgres-də hazırı yoxdur. Sətir `%XX` və tək simvollara bölünür, hamısı
 * onaltılığa çevrilib bir bytea-ya yığılır, sonra UTF-8 kimi oxunur — yəni
 * çoxbaytlı hərflər (`%C9%99` → ə) də düzgün açılır, bayt-bayt yox.
 */
CREATE OR REPLACE FUNCTION katibe.url_decode(input text) RETURNS text AS $$
  SELECT convert_from(
    CAST(E'\\x' || string_agg(
      CASE WHEN length(r.m[1]) = 1
           THEN encode(convert_to(r.m[1], 'UTF8'), 'hex')
           ELSE substring(r.m[1] from 2 for 2)
      END, '') AS bytea),
    'UTF8')
  FROM regexp_matches($1, '%[0-9a-fA-F][0-9a-fA-F]|.', 'g') AS r(m);
$$ LANGUAGE SQL IMMUTABLE STRICT;

ALTER FUNCTION katibe.url_decode(text) OWNER TO evolution;

-- Bucket adı burada yazılıb, çünki açarın içindəki səhv də bu quraşdırmaya
-- aiddir. Başqa quraşdırmada işlədilirsə, :bucket dəyişdirilməlidir.
\set bucket 'katibe'

UPDATE katibe.media
   SET object_key = katibe.url_decode(
         regexp_replace(object_key, '^' || :'bucket' || '/', ''))
 WHERE storage = 'evolution'
   AND object_key IS NOT NULL
   AND (object_key LIKE :'bucket' || '/%' OR object_key ~ '%[0-9a-fA-F]{2}');

SELECT count(*) AS duzeldilmis_setir
  FROM katibe.media
 WHERE storage = 'evolution' AND object_key IS NOT NULL
   AND object_key NOT LIKE :'bucket' || '/%';

COMMIT;
