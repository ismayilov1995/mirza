-- Named, reusable SLA policies attached to Katibe users.
--
-- A rule sets a response-time target that depends on WHEN the customer's
-- message arrived, evaluated in the rule's own timezone:
--
--   * a business day, inside the business-hours window  -> target_business_minutes
--   * a business day, outside that window               -> target_offhours_minutes
--   * a non-business day                                -> target_weekend_minutes
--
-- Every number, the window, the set of business days and the timezone are
-- admin-configured per rule; nothing here is hardcoded to one company's
-- schedule. Lives in the katibe schema, untouched by Evolution's migrations.
-- Safe to re-run.
--
-- WHY VERSIONS, NOT PLAIN COLUMNS
--
-- No response-time number in Katibe is stored: getWorkloadStats() recomputes
-- everything from evolution_api."Message" on each request. So the risk of an
-- edited rule is not that some saved row gets overwritten -- it is that next
-- week's recomputation of LAST week silently applies today's targets. A
-- version counter cannot prevent that; only a validity range the query can
-- join on can. Hence: sla_rule_versions rows are immutable (enforced by
-- trigger) and carry [effective_from, effective_to); a measurement resolves
-- the version whose range contains the customer message's arrival instant.
--
-- Two conventions keep the past intact without asking the admin anything:
--
--   * version 1 of a rule starts at -infinity. Nothing could have been
--     measured under a rule that did not exist yet, so back-dating it is
--     free and lets a newly created rule cover existing history.
--   * every later edit closes the current version at now() and opens the
--     next one there, so only future measurements see the change.
--
-- The user<->rule link is temporal for the same reason (see
-- 2026-08-24_assignment_history.sql, which fixed exactly this class of bug
-- for user_instances). A user's first-ever attachment may back-date freely;
-- re-pointing them later takes effect from now on.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Identity of a rule. Renaming is safe: the name is not a measurement input.
CREATE TABLE IF NOT EXISTS katibe.sla_rules (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Soft delete. A rule that was ever attached to anyone can be retired out
  -- of the picker but never dropped, because past measurements still have to
  -- resolve it.
  retired_at timestamptz
);

-- Immutable configuration. One row per edit.
CREATE TABLE IF NOT EXISTS katibe.sla_rule_versions (
  id             serial PRIMARY KEY,
  rule_id        integer NOT NULL REFERENCES katibe.sla_rules(id) ON DELETE RESTRICT,
  version        integer NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,               -- NULL = currently in force

  -- IANA zone name, never a fixed offset: the offset for a given instant is
  -- whatever tzdata says it was THEN, so DST transitions classify correctly.
  timezone       text NOT NULL,
  business_start time NOT NULL,             -- local wall time in `timezone`
  business_end   time NOT NULL,
  business_days  smallint[] NOT NULL,       -- ISO dow, 1=Mon .. 7=Sun

  target_business_minutes integer NOT NULL,
  target_offhours_minutes integer NOT NULL,
  target_weekend_minutes  integer NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sla_rule_versions_rule_version_key UNIQUE (rule_id, version),
  -- A window that wraps midnight would make "inside business hours" ambiguous
  -- across the day boundary; rejected rather than guessed at.
  CONSTRAINT sla_business_window_ordered CHECK (business_end > business_start),
  CONSTRAINT sla_business_days_valid CHECK (
    business_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
    AND array_length(business_days, 1) BETWEEN 1 AND 7
  ),
  CONSTRAINT sla_targets_positive CHECK (
    target_business_minutes > 0 AND target_offhours_minutes > 0 AND target_weekend_minutes > 0
  ),
  -- Two versions in force at once would let attribution silently pick one.
  CONSTRAINT no_overlapping_versions EXCLUDE USING gist (
    rule_id WITH =,
    tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz)) WITH &&
  )
);

CREATE INDEX IF NOT EXISTS sla_rule_versions_rule_from_idx
  ON katibe.sla_rule_versions (rule_id, effective_from);

-- A CHECK constraint has to be immutable, so it cannot consult
-- pg_timezone_names. A trigger can -- and unlike an FK to a copied list of
-- zone names, it never goes stale when tzdata is updated.
CREATE OR REPLACE FUNCTION katibe.assert_iana_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown IANA timezone: % (store a zone name such as Asia/Baku, not an offset)', NEW.timezone;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sla_rule_versions_tz_check ON katibe.sla_rule_versions;
CREATE TRIGGER sla_rule_versions_tz_check
  BEFORE INSERT OR UPDATE ON katibe.sla_rule_versions
  FOR EACH ROW EXECUTE FUNCTION katibe.assert_iana_timezone();

-- Immutability, enforced rather than merely intended: closing a version is
-- the only permitted update, and rows never disappear. Without this, one
-- stray UPDATE in a future migration silently re-judges every past reply.
CREATE OR REPLACE FUNCTION katibe.sla_rule_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Deleting is refused once the rule has ever been attached to a user,
  -- because some past measurement may resolve through this row. A rule
  -- created by mistake and never attached can still be thrown away -- no
  -- measurement can possibly reference it.
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM katibe.user_sla_rules WHERE rule_id = OLD.rule_id) THEN
      RAISE EXCEPTION 'katibe.sla_rule_versions is append-only: version % of rule % has been in use and cannot be deleted',
        OLD.version, OLD.rule_id;
    END IF;
    RETURN OLD;
  END IF;

  IF ROW(NEW.id, NEW.rule_id, NEW.version, NEW.effective_from, NEW.timezone,
         NEW.business_start, NEW.business_end, NEW.business_days,
         NEW.target_business_minutes, NEW.target_offhours_minutes,
         NEW.target_weekend_minutes, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.rule_id, OLD.version, OLD.effective_from, OLD.timezone,
         OLD.business_start, OLD.business_end, OLD.business_days,
         OLD.target_business_minutes, OLD.target_offhours_minutes,
         OLD.target_weekend_minutes, OLD.created_at) THEN
    RAISE EXCEPTION 'katibe.sla_rule_versions is immutable: edit a rule by closing this version and inserting the next one';
  END IF;

  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'effective_to is set once (version % of rule % is already closed)', OLD.version, OLD.rule_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sla_rule_versions_immutable ON katibe.sla_rule_versions;
CREATE TRIGGER sla_rule_versions_immutable
  BEFORE UPDATE OR DELETE ON katibe.sla_rule_versions
  FOR EACH ROW EXECUTE FUNCTION katibe.sla_rule_version_guard();

-- Which rule applied to which user, when.
CREATE TABLE IF NOT EXISTS katibe.user_sla_rules (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES katibe.users(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: this is what makes "delete is blocked while the
  -- rule is attached" a database guarantee and not just a UI check.
  rule_id     integer NOT NULL REFERENCES katibe.sla_rules(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  CONSTRAINT no_overlapping_sla_assignments EXCLUDE USING gist (
    user_id WITH =,
    tstzrange(assigned_at, COALESCE(ended_at, 'infinity'::timestamptz)) WITH &&
  )
);

CREATE INDEX IF NOT EXISTS user_sla_rules_user_assigned_idx
  ON katibe.user_sla_rules (user_id, assigned_at);
CREATE INDEX IF NOT EXISTS user_sla_rules_rule_idx
  ON katibe.user_sla_rules (rule_id);

-- Resolves the target, in seconds, that applied to a message that arrived at
-- `arrived_at` on `instance_id`. NULL when the holder of that number had no
-- rule then (or no holder at all) -- callers must show that as "no target",
-- never as "on time".
--
-- Chain, every step point-in-time: instance -> holder then -> that user's
-- rule then -> that rule's version then.
CREATE OR REPLACE FUNCTION katibe.sla_target_seconds(instance_id text, arrived_at timestamptz)
RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN EXTRACT(isodow FROM local_ts)::smallint <> ALL (v.business_days)
             THEN v.target_weekend_minutes
           WHEN local_ts::time >= v.business_start AND local_ts::time < v.business_end
             THEN v.target_business_minutes
           ELSE v.target_offhours_minutes
         END * 60
  FROM katibe.user_instances ui
  JOIN katibe.user_sla_rules usr
    ON usr.user_id = ui.user_id
   AND tstzrange(usr.assigned_at, COALESCE(usr.ended_at, 'infinity'::timestamptz)) @> arrived_at
  JOIN katibe.sla_rule_versions v
    ON v.rule_id = usr.rule_id
   AND tstzrange(v.effective_from, COALESCE(v.effective_to, 'infinity'::timestamptz)) @> arrived_at
  -- The zone is applied at the arrival instant, so tzdata decides the offset
  -- that was actually in force -- correct across DST transitions.
  CROSS JOIN LATERAL (SELECT arrived_at AT TIME ZONE v.timezone) AS l(local_ts)
  WHERE ui.instance_id = sla_target_seconds.instance_id
    AND tstzrange(ui.assigned_at, COALESCE(ui.ended_at, 'infinity'::timestamptz)) @> arrived_at
  LIMIT 1;
$$;
