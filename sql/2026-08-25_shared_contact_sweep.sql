-- "Appears in 3 of our 4 accounts" -> not a client.
--
-- A customer belongs to one salesperson. Someone the owner's private account
-- AND two sales accounts all talk to directly is staff, a supplier or a
-- courier — the company's own orbit. identify-clients.ts already refuses to
-- classify these (rule 2, ">1 instance"), but it only ever *skipped* them and
-- wrote nothing, so they stayed unlabelled and therefore stayed inside the
-- supervisor's watch list forever. This writes the decision down.
--
-- Threshold is 3, not 2, deliberately: at 2 the rule catches real clients who
-- wrote to a second store number. Measured on 2026-08-25, the "exactly 3"
-- tier still held 5 contacts already labelled Client (two of them plainly
-- genuine — "Riyad müştərisi", "Shamma Fahad Alkaabi — Doha"), while the
-- all-4 tier was clean. That is why this NEVER overwrites an existing
-- category: it only fills empty ones, and a wrong Client label survives.
--
-- @lid IS NORMALISED FIRST. WhatsApp shows the same person as @lid to one
-- account and @<number>@s.whatsapp.net to another; grouping by raw JID found
-- only 6 contacts in all four accounts, and grouping by resolved number found
-- 21. The mapping is katibe.lid_number, which is ~10% complete and cannot be
-- backfilled on demand (see 2026-08-24_lid_number.sql), so an unmapped @lid
-- stays its own identity and the rule still under-counts — just far less.
BEGIN;

CREATE TEMP TABLE _ident ON COMMIT DROP AS
SELECT DISTINCT m."instanceId",
       m.key->>'remoteJid' AS jid,
       CASE WHEN m.key->>'remoteJid' LIKE '%@s.whatsapp.net'
              THEN split_part(m.key->>'remoteJid', '@', 1)
            WHEN l.phone_number IS NOT NULL THEN l.phone_number
            ELSE m.key->>'remoteJid' END AS person
FROM evolution_api."Message" m
LEFT JOIN katibe.lid_number l ON l.lid_jid = m.key->>'remoteJid'
WHERE (m.key->>'remoteJid' LIKE '%@s.whatsapp.net' OR m.key->>'remoteJid' LIKE '%@lid')
  AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage');

-- Labels are keyed by JID, so a person merged from two forms gets a row for
-- each — which is what clientScopeSql() (src/lib/supervisor/scope.ts) matches on.
CREATE TEMP TABLE _targets ON COMMIT DROP AS
SELECT x.jid,
       COALESCE(
         (SELECT ch.name FROM evolution_api."Chat" ch
           WHERE ch."remoteJid" = x.jid AND ch.name IS NOT NULL LIMIT 1),
         (SELECT ct."pushName" FROM evolution_api."Contact" ct
           WHERE ct."remoteJid" = x.jid AND ct."pushName" IS NOT NULL LIMIT 1),
         split_part(x.jid, '@', 1)) AS name
FROM (SELECT person, array_agg(DISTINCT jid) AS jids
      FROM _ident GROUP BY person
      HAVING count(DISTINCT "instanceId") >= 3) c
CROSS JOIN LATERAL unnest(c.jids) AS x(jid);

INSERT INTO katibe.contact_labels (remote_jid, display_name, category_id)
SELECT t.jid, t.name, (SELECT id FROM katibe.categories WHERE name = 'Other')
FROM _targets t
ON CONFLICT (remote_jid) DO NOTHING;

-- The FK is ON DELETE SET NULL, so a row can exist with no category. Those
-- count as "not classified yet" and get filled too; a set category never does.
UPDATE katibe.contact_labels cl
SET category_id = (SELECT id FROM katibe.categories WHERE name = 'Other'),
    updated_at = now()
FROM _targets t
WHERE cl.remote_jid = t.jid AND cl.category_id IS NULL;

COMMIT;
