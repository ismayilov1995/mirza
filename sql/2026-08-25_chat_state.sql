-- Söhbət halı (chat state) — hər 1:1 söhbətin LLM ilə təyin olunmuş vəziyyəti.
--
-- Nəyi həll edir: deterministik qaydalar "kim gözləyir"i görür, amma "qiymət
-- verilib, müştəri düşünür" və "son mesaj sadəcə nəzakətdir, cavab istəmir"
-- hallarını görə bilmir. Bu cədvəl həmin mühakiməni BİR DƏFƏ hesablayıb
-- saxlayır: yenidən təsnifat yalnız söhbətə təzə mesaj gələndə olur
-- (last_message_ts açarı), dəyişməyən söhbət heç nə xərcləmir.
--
-- Sətir söhbət başına BİRDİR (tarixçə yox): halın keçmişi maraqlı deyil,
-- işlək olan "indi nə vəziyyətdədir" sualıdır. Model/confidence/reason
-- auditə görə saxlanır. Yenilənmə scripts/classify-chat-states.ts və
-- Nəzarətçi gedişatındadır. Təkrar işlətmək təhlükəsizdir.

CREATE TABLE IF NOT EXISTS katibe.chat_state (
  instance_id     text NOT NULL,
  remote_jid      text NOT NULL,
  state           text NOT NULL CHECK (state IN
    ('WAITING_ON_US', 'CUSTOMER_DECIDING', 'IN_PROGRESS', 'RESOLVED', 'FILLER', 'STALE')),
  confidence      text NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  reason          text NOT NULL,
  model           text NOT NULL,
  -- Təsnif olunan anda söhbətin son mesajının vaxtı. Yenidən hesablama şərti:
  -- MAX("messageTimestamp") > last_message_ts.
  last_message_ts bigint NOT NULL,
  message_count   int NOT NULL,
  classified_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, remote_jid)
);

CREATE INDEX IF NOT EXISTS chat_state_state_idx
  ON katibe.chat_state (instance_id, state);
