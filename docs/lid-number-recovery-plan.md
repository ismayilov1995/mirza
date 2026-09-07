# Recovering phone numbers behind `@lid` chats

## Why this matters

Of the 135 numbers the client sweep identified as **Client**, only **3** have a
visible phone number. The other 132 are `@lid` — WhatsApp's "Linked ID" privacy
addressing, which replaces the phone number with an opaque id.

It is worst exactly where it hurts most. On `Rouz-2`, the actual Sophie Couture
sales account, 631 of 632 individual chats are `@lid`, and 628 of those carry no
push name either. The AI sweep can still tell *who is a client* from what was
said, but it cannot produce a number to call back.

## What the platform actually allows

Read before designing anything here, because it rules out the obvious approach.
From `node_modules/baileys/lib/Signal/lid-mapping.js` (Baileys 7.0.0-rc.9):

| Direction | Method | Network lookup? |
| --- | --- | --- |
| LID → phone number | `getPNForLID(lid)` | **No.** Reads the local store; returns `null` on a miss. |
| Phone number → LID | `getLIDForPN(pn)` | **Yes** — USYNC via `pnToLIDFunc`, and it stores both directions on success. |

So **an arbitrary `@lid` cannot be turned into a phone number.** If WhatsApp never
sent us the pairing, nothing local or remote will produce it. That is the whole
point of LID.

This also means patching Evolution to call `getPNForLID` on chats — the plan we
started with — would surface only mappings that are already stored, which can be
read straight out of Redis without touching Evolution at all. Not worth a fork
or a restart of the live WhatsApp connection.

Evolution itself already calls `getPNForLID`, but only for incoming calls
(`whatsapp.baileys.service.ts:1892`) — never for chats, contacts or messages.

## What is actually stored right now

Signal state lives in Redis (`CACHE_REDIS_ENABLED=true`, db 6, key
`evolution:instance:<instanceId>`), as hash fields:

```
lid-mapping-<phoneNumber>          => <lidUser>      # forward
lid-mapping-<lidUser>_reverse      => <phoneNumber>  # reverse — what we want
```

Measured coverage:

| | |
| --- | --- |
| reverse mappings present | 73 |
| `@lid` chats they cover | 52 of 799 |
| hidden Clients they cover | **7 of 132** |

The hash carries no TTL (`TTL` returns `-1`), so entries are not expiring. But
they exist **only in Redis** — a `FLUSHDB`, a Redis reinstall, or a cache wipe
during maintenance destroys them, and they cannot be reconstructed.

`/chat/whatsappNumbers` does not help as-is: it returns `jid`, `exists`,
`number`, `name` and drops the `lid` that Baileys knows.

## Plan

### A. Harvest what exists — no patch, no restart

A read-only script reads the `*_reverse` fields out of Redis and upserts them
into a new `katibe.lid_number` table (`lid_jid` primary key, `phone_number`,
`first_seen_at`, `last_seen_at`). The contact directory and the client review
page then show the number wherever one is known.

Immediate yield is small — 52 chats, 7 clients — but the cost is a script and a
table, there is no risk to the WhatsApp session, and it is the prerequisite for
everything below.

### B. Stop losing them

Mappings accumulate on their own as clients message the account: Baileys records
a pairing whenever a message envelope carries both identifiers. That growth is
currently trapped in a cache nobody backs up.

Run A on a cron (hourly is plenty) so the Postgres table only ever grows.
Coverage then improves passively, and survives anything that happens to Redis.

Add the table to the existing `scripts/backup-katibe.sh` set.

### C. Resolve numbers we already know — the only path that adds new coverage

`getLIDForPN` *does* query WhatsApp, and storing its result fills in the reverse
mapping too. So a known phone number can be pinned to a chat, even though the
reverse is impossible.

This needs the one genuine Evolution patch: expose `lid` on the
`whatsappNumbers` response (or add an endpoint) that calls
`signalRepository.lidMapping.getLIDForPN()` instead of relying on `onWhatsApp`,
which currently drops it. A verification test confirmed the existing endpoint
creates no mapping for a number that has none.

It also needs something only the business can supply: **a list of customer phone
numbers** — from the CRM, the phone's address book, order records, invoices.
Each number resolves to a LID, which matches a chat we have already classified.

Sequence: patch → rebuild → restart Evolution (this drops and re-establishes the
WhatsApp connection, so it is scheduled deliberately, not done in passing) →
feed the number list through in batches → harvest with A.

### Not planned

- Guessing or brute-forcing LIDs. They are not derived from the phone number.
- Any endpoint that opens a chat or marks messages read. The whole Katibe
  constraint stands: `readMessages`/`readStatus` stay `false`, and nothing here
  calls `chat/markMessageAsRead`. Reading Redis and calling `whatsappNumbers`
  touch no read state.

## Order of work

A and B are independent of C and carry no risk to the live session — they can
ship first. C is gated on the customer number list and on a deliberate restart
window.
