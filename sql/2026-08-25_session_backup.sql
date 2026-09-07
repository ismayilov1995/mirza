-- WhatsApp sessiya kredensiallarının davamlı nüsxəsi.
--
-- Nə üçün: Evolution sessiyanı oxuya bilməyəndə onu YENİDƏN YARADIR və
-- işləyən sətrin üstünə yazır (use-multi-file-auth-state-prisma.ts):
--
--     let creds = await readData('creds');
--     if (!creds) { creds = initAuthCreds(); await writeData(creds, 'creds'); }
--
-- readData/getAuthKey/keyExists — üçü də `catch { return null }`. Yəni
-- bazadan oxumaq bir anlıq alınmasa (timeout, pool tükənməsi, yaddaş
-- təzyiqi), "sessiya yoxdur" ilə "sessiyanı oxuya bilmədim" eyni sayılır və
-- qoşulmuş sessiya bir sətirlə məhv olur. 2026-08-25-də Rouz və Rouz-2 məhz
-- belə itdi: 30 saniyə fərqlə, Zemfira 4-cü instans kimi yaradılandan
-- 2 saniyə sonra, boks 2.2 GB swap-da ikən.
--
-- Bu cədvəl həmin bir sətri geri qaytarmağa imkan verir.
--
-- YALNIZ ETİBARLI NÜSXƏ SAXLANILIR. Etibarlı = creds içində me + account +
-- signalIdentities var, yəni qoşulmuş kimlik. Qoşulmamış (initAuthCreds)
-- kredensial buraya HEÇ VAXT düşmür — əks halda skript öz-özünə zibili
-- yaxşının üstünə yazardı, yəni məhz qarşısını almalı olduğu şeyi edərdi.
--
-- Məzmun gizlidir (şəxsi açarlar). Eyni bazadadır, yəni evolution_api."Session"
-- ilə eyni etibar sərhədindədir — yeni sirr yeri açmır. Backup skripti
-- (backup-katibe.sh) katibe sxemini onsuz da götürür.
CREATE TABLE IF NOT EXISTS katibe.session_backup (
  id           bigserial PRIMARY KEY,
  instance_id  text NOT NULL,
  instance_name text NOT NULL,
  -- evolution_api."Session".creds olduğu kimi, hərfi-hərfinə. Parse edilmir:
  -- dəyər iki qat JSON-dur (Baileys BufferJSON + Evolution JSON.stringify) və
  -- onu açıb-bağlamaq geri yazanda fərq yaratma riskidir.
  creds        text NOT NULL,
  creds_bytes  int NOT NULL,
  taken_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_backup_instance_idx
  ON katibe.session_backup (instance_id, taken_at DESC);

-- Eyni kredensial dəyişməyibsə təkrar sətir yazılmır (skript yoxlayır), ona
-- görə bu indeks həm də "sonuncu nüsxə nə vaxt dəyişdi" sualına cavab verir.
