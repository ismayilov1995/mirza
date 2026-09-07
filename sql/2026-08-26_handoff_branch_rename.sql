-- FORWARDED_TO_DUBAI → FORWARDED_TO_BRANCH.
--
-- İlk təsnifat gedişatı göstərdi ki, şirkətin Dubaydan başqa filialı da var:
-- beş söhbətdən biri "Let me share your number with our Riyadh team" idi.
-- Hal eynidir — top bizim tərəfdə deyil — amma "Dubaya yönləndirilib" etiketi
-- Riyad üçün sadəcə yalandır. Ona görə hal filialın adını daşımır; hansı
-- filial olduğu `reason` sahəsində modelin öz cümləsi ilə qalır.
--
-- Təkrar işlətmək təhlükəsizdir.

ALTER TABLE katibe.chat_state
  DROP CONSTRAINT IF EXISTS chat_state_state_check;
ALTER TABLE katibe.chat_state
  ADD CONSTRAINT chat_state_state_check
  CHECK (state IN (
    'WAITING_ON_US', 'CUSTOMER_DECIDING', 'IN_PROGRESS', 'RESOLVED',
    'FILLER', 'STALE', 'FORWARDED_TO_DUBAI', 'FORWARDED_TO_BRANCH', 'FOR_PR'
  ));

UPDATE katibe.chat_state SET state = 'FORWARDED_TO_BRANCH' WHERE state = 'FORWARDED_TO_DUBAI';

ALTER TABLE katibe.chat_state
  DROP CONSTRAINT IF EXISTS chat_state_state_check;
ALTER TABLE katibe.chat_state
  ADD CONSTRAINT chat_state_state_check
  CHECK (state IN (
    'WAITING_ON_US', 'CUSTOMER_DECIDING', 'IN_PROGRESS', 'RESOLVED',
    'FILLER', 'STALE', 'FORWARDED_TO_BRANCH', 'FOR_PR'
  ));

DROP INDEX IF EXISTS katibe.chat_state_handoff_idx;
CREATE INDEX IF NOT EXISTS chat_state_handoff_idx
  ON katibe.chat_state (state, classified_at DESC)
  WHERE state IN ('FORWARDED_TO_BRANCH', 'FOR_PR');
