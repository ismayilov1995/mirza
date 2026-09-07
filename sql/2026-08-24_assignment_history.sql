-- Nömrə–adam bağlantısına tarixçə əlavə edir.
--
-- Əvvəl: user_instances-in PRIMARY KEY-i (instance_id) idi — yəni bir nömrəyə
-- yalnız BİR sətir. Nömrə başqasına keçəndə həmin sətri dəyişmək lazım gəlirdi
-- və bu, o nömrənin BÜTÜN keçmiş statistikasını yeni adamın adına yazırdı.
--
-- İndi: hər təyinat ayrıca sətirdir, başlanğıc/bitiş tarixi ilə. Mesajın kimə
-- aid olduğu onun ÖZ vaxtına görə tapılır, keçmiş toxunulmaz qalır.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Surroqat açar: instance_id artıq unikal deyil.
ALTER TABLE katibe.user_instances DROP CONSTRAINT IF EXISTS user_instances_pkey;
ALTER TABLE katibe.user_instances ADD COLUMN IF NOT EXISTS id serial PRIMARY KEY;
ALTER TABLE katibe.user_instances ADD COLUMN IF NOT EXISTS ended_at timestamptz;

-- assigned_at əvvəl "biz bunu nə vaxt qeyd etdik" demək idi (hər ikisi
-- 2026-08-24), halbuki İsmayılın nömrəsində 2024-cü ildən mesaj var. Vaxta
-- görə axtaranda o mesajlar heç kimə düşməzdi. Ona görə hər təyinatın
-- başlanğıcını həmin nömrədəki ƏN KÖHNƏ mesajın vaxtına çəkirik.
UPDATE katibe.user_instances ui
SET assigned_at = LEAST(
      ui.assigned_at,
      COALESCE(
        (SELECT to_timestamp(MIN(m."messageTimestamp"))
         FROM evolution_api."Message" m
         WHERE m."instanceId" = ui.instance_id),
        ui.assigned_at
      )
    )
WHERE ui.ended_at IS NULL;

-- İki eyni vaxtlı sahib mümkün olmamalıdır — onda attribution səssizcə birini
-- seçərdi. Burada sütunlar timestamptz-dir, ona görə tstzrange işləyir.
ALTER TABLE katibe.user_instances DROP CONSTRAINT IF EXISTS no_overlapping_assignments;
ALTER TABLE katibe.user_instances
  ADD CONSTRAINT no_overlapping_assignments
  EXCLUDE USING gist (
    instance_id WITH =,
    tstzrange(assigned_at, COALESCE(ended_at, 'infinity'::timestamptz)) WITH &&
  );

CREATE INDEX IF NOT EXISTS user_instances_instance_assigned_idx
  ON katibe.user_instances (instance_id, assigned_at);
