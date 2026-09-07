> Layihəyə ilk dəfə baxırsınız? Quraşdırma və qaydalar: **[BASLANGIC.md](BASLANGIC.md)**.
> Bu sənəd isə hər qərarın *niyəsini* izah edir.

Katibe dashboard — read-only WhatsApp chat statistics over Evolution API's own Postgres DB. Never calls the Evolution API itself, so it can never mark anything as read.

## Adding a WhatsApp account

Admin → **Yeni WhatsApp qoş** creates an Evolution instance and opens a pairing page that polls for a fresh QR (WhatsApp expires them after about a minute, so a static image would silently go stale). Scan it from the employee's phone via Settings → Linked devices.

Instances are always created with `SAFE_INSTANCE_SETTINGS` (`src/lib/evolution.ts`): `readMessages` and `readStatus` false, which is what keeps Katibe from marking anything as read on the owner's phone. `alwaysOnline` false leaves presence alone and `syncFullHistory` false avoids pulling years of backlog on first connect. Never create an instance outside this helper.

### Why `alwaysOnline` must stay false

`alwaysOnline` is the only thing that decides whether a newly linked number keeps
getting push notifications on its own phone. Evolution passes it straight through
to Baileys as `markOnlineOnConnect`
(`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts:651`), and on
every `connection: open` Baileys sends a presence stanza either way
(`node_modules/baileys/lib/Socket/chats.js:889`):

    sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable')

With `alwaysOnline: true` the linked session announces itself as the active
device, and WhatsApp stops pushing to the phone — the employee only sees messages
when they open the app. With it false, Baileys announces `unavailable`, so the
phone stays the notified device. There is no separate presence call to make: the
`unavailable` is already sent for us. Nothing about this is logged, so a wrong
setting is silent until someone notices they stopped being notified.

`SAFE_INSTANCE_SETTINGS` sets it correctly for every instance the dashboard
creates. An instance created by hand against the Evolution API can still get it
wrong, so after adding any number, confirm it:

```bash
psql "$PGURI" -c 'select i.name, s."alwaysOnline", s."readMessages", s."readStatus"
  from evolution_api."Instance" i
  join evolution_api."Setting" s on s."instanceId" = i.id
  order by i."createdAt";'
```

All three columns must be `f`. The setting is read once when the socket is built,
so correcting a row in the database only takes effect on the instance's next
reconnect.

The Evolution API key stays server-side — the browser only ever talks to `/api/instance/status`, which sits behind the session proxy.

## Backups

`scripts/backup-katibe.sh` dumps the `katibe` schema nightly at 04:30 to `/var/backups/katibe`, keeping 14 days. Only `katibe` is backed up: `evolution_api` is a re-syncable cache of WhatsApp, while `katibe` holds work that exists nowhere else — the names and categories a person typed, the synced group subjects, and AI summaries that cost money to produce.

```bash
./scripts/backup-katibe.sh
```

Restore:

```bash
zcat /var/backups/katibe/katibe-YYYY-MM-DD_HHMM.sql.gz | psql "$DATABASE_URL"
```

The script fails loudly if the dump comes out under 1KB, so a half-written file is never mistaken for a good backup.

## Chat analysis (AI)

Opening a chat runs nothing. The detail page shows the last 10 messages and whatever analysis is already stored; a new one only starts when someone picks a model and presses **Təhlil et**, so a page view never costs API credit.

Analysis is keyed by JID alone, like names are. A group two employees are both in is one conversation, so it is analysed once and every account's dashboard shows that same result — the transcript is read from whichever account saw most of it. Measured before deciding this: merging both copies of a shared chat recovers only 0-5% more messages, because the fuller copy already has nearly everything, so the second run would have cost the same and said the same thing.

Every run is appended to `katibe.chat_summary` rather than overwriting, keyed by model and timestamp — the page shows the newest and lists earlier ones. Default model is Sonnet 5; Opus 5 and Haiku 4.5 are selectable per chat from the dropdown. Haiku 4.5 predates adaptive thinking and rejects `output_config.effort`, so `SUMMARY_MODELS` in `src/lib/summary.ts` carries a per-model request shape rather than one shared config.

## Chat name + category suggestions (AI)

WhatsApp gives no name at all for a large share of chats — the contact isn't in the address book, or it's an `@lid` JID with the number masked. `scripts/suggest-chats.ts` reads the last 25 messages of each unlabeled chat and proposes a display name plus one of the admin's categories, storing them in `katibe.chat_suggestion`.

```bash
npm run suggest:chats
```

```bash
SUGGEST_MAX_CHATS=50 npm run suggest:chats
```

```bash
SUGGEST_REDO=1 npm run suggest:chats
```

A suggestion never replaces a name WhatsApp already provides — accepting one applies only the category when the chat has a group subject or a contact pushName, since "Isklad" is a better name than the model's "Sifariş və parça istehsal qrupu". `katibe.contact_labels.display_name` is nullable so a row can carry a category alone.

Suggestions are proposals, never labels: `katibe.contact_labels` is written only when someone clicks **Qəbul et** in the dashboard's Chat-lər section (filter `🤖 AI təklifi`). Rejecting marks the suggestion resolved so it isn't offered again, and editing a chat's name by hand resolves it too. Chats with fewer than 5 messages are skipped — there's nothing to judge from.

## Client identification (AI)

Which numbers are **clients** is the question every other analysis hangs off of, so it gets its own pass rather than being one option in a flat category list. `scripts/identify-clients.ts` sweeps individual chats only — `@s.whatsapp.net` and `@lid` (a `@lid` is a one-to-one contact whose number WhatsApp has masked, *not* a group) — and asks one question per number: does this side buy from us? Direction of trade is the rule: money coming in and goods going out means Client; the reverse means Supplier or Production. Only if the answer is no does the model pick what they are instead.

```bash
npm run identify:clients
```

```bash
CLIENT_DRY_RUN=1 CLIENT_MAX_CHATS=8 npm run identify:clients
```

Other knobs: `CLIENT_MAX_CHATS` (default 200), `CLIENT_MIN_MESSAGES` (default 5), `CLIENT_REDO=1` to re-examine numbers proposed before but never resolved.

**HIGH-confidence calls are applied immediately.** There are several hundred numbers to get through and confirming them one at a time was never going to happen, so the sweep writes those labels itself and records the proposal as `resolution = 'AUTO'` — a third state next to `ACCEPTED`/`REJECTED`, so an automatic label stays distinguishable from one a human agreed to. The prompt is what keeps HIGH scarce: it says outright that a HIGH answer skips review, and that a lead who only asked for the address is at most MEDIUM. Everything below HIGH queues up instead.

`/admin/suggestions` is where the queue gets cleared. Rows arrive pre-ticked and ordered client-first, so reviewing means unticking the wrong ones rather than ticking the right ones; **→ Client et** promotes a row the model put in the wrong bucket in one click. The same page lists every auto-applied label with **Geri al**, which deletes the label and marks the proposal rejected — a HIGH call is never final. An auto-apply also backs off entirely if a human labelled the number in the meantime.

Both this script and the dashboard's accept button go through `applySuggestion()` in `src/lib/suggestions.ts`, so a human accept and an automatic one write exactly the same label — including never replacing a name WhatsApp already knows.

### Choosing the model

This is bulk classification over short excerpts, not work that needs the strongest model available, and the per-run cost is the difference between sweeping the whole address book and rationing it. `CLIENT_PROVIDER` picks `openai` (default) or `anthropic`, `CLIENT_MODEL` overrides the model; the defaults are `gpt-5.4-mini` and `claude-sonnet-5`. The prompt and the zod schema are shared, so switching provider is a config change, not a re-tuning.

The first full sweep ran on `claude-opus-5` and exhausted the Anthropic credit balance at batch 25 of 52 — which is why the default is a mini-tier model now. Check what a model actually does before trusting it with auto-apply: `CLIENT_DRY_RUN=1` prints every call with its reason and writes nothing.

### Keeping up with new numbers

The sweep is manual on purpose — it spends money, so nothing schedules it without being asked. To have new numbers picked up on their own, add a cron entry:

```
0 6 * * * cd /var/www/katibe-dashboard && PATH=/root/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin CLIENT_MAX_CHATS=100 /root/.nvm/versions/node/v24.19.0/bin/npx tsx scripts/identify-clients.ts >> /var/www/katibe-dashboard/logs/identify-clients.log 2>&1
```

## Phone numbers behind `@lid` chats

WhatsApp's LID addressing replaces the phone number with an opaque id, and on the sales account almost every chat is one: 631 of 632 individual chats on `Rouz-2` are `@lid`, and 628 carry no push name either. Of the numbers the client sweep identified as Client, only a handful have a number you could dial.

**This cannot be reversed on demand.** In Baileys 7.0.0-rc.9 (`node_modules/baileys/lib/Signal/lid-mapping.js`), `getPNForLID()` reads a local store and returns `null` on a miss — there is no network lookup behind it. Only `getLIDForPN()`, the other direction, queries WhatsApp. So the only pairings that will ever exist are the ones WhatsApp volunteered while messages flowed, and the job here is to not lose those.

Evolution keeps them in its Redis signal state (db 6, hash `evolution:instance:<id>`, fields `lid-mapping-<lidUser>_reverse`). The fields carry no TTL, but Redis is a cache: a `FLUSHDB` or a reinstall erases them and nothing can rebuild them. `scripts/harvest-lid-numbers.ts` copies them into `katibe.lid_number`, which the nightly schema backup already covers.

```bash
npm run harvest:lids
```

```bash
HARVEST_VERBOSE=1 npm run harvest:lids
```

Runs at :15 every hour by cron. Coverage grows on its own — Baileys records a pairing whenever a message envelope carries both identifiers — so the table only ever gets fuller.

### Keeping the canonical store current

Every screen except the instance list reads `katibe.message`, not Evolution
directly. That table is filled by the mirror:

```bash
npm run mirror:evolution
```

Runs every 5 minutes by cron. It is idempotent — it finds its work by
anti-joining `katibe.message_source`, so running it twice changes nothing and
an interrupted run resumes where it stopped. When it writes anything it also
calls `katibe.refresh_chat_stats()`, which is what keeps the conversation
counts and the list's ordering honest.

This was not scheduled until 2026-08-31 and the cost was invisible rather than
loud: the supervisor's chat list simply stopped moving. By the time it was
noticed, 3,060 messages had never reached the store and the screen was showing
data 8.5 hours old — with no error anywhere, because every query it ran was
correct about a table that had stopped growing. If the list ever looks frozen
again, check `logs/mirror.log` first.

Two details worth knowing before touching this script, because both fail silently rather than loudly:

- node-redis v6's `scanIterator` yields a **batch of keys** per iteration, not one key. Treating a batch as a single key harvests nothing and reports no error.
- The stored values are **double JSON-encoded** (`"\"971500000006\""`) — Evolution's cache layer encodes what Baileys already encoded. Peel until the result stops being a string; one parse too many reads the bare digits as a JSON number.

The number shows up in the contact directory and on `/admin/suggestions`, linked to `wa.me`. Where WhatsApp hides it, the row says so outright rather than leaving a blank — "no number" is information, not a gap in the data.

Recovering numbers we don't already have needs a different approach entirely, gated on a list of known customer numbers and a patch to Evolution: see `docs/lid-number-recovery-plan.md`.

## Group names from the live API

Evolution's cached `Chat.name` is incomplete — 268 group rows against 395 groups the API reports, and several groups the dashboard showed as unnamed had real names all along. `scripts/sync-groups.ts` pulls the current subjects and caches them in `katibe.group_subject`:

```bash
npm run sync:groups
```

It only calls `GET /group/fetchAllGroups`, which is Baileys' `groupFetchAllParticipating()` — a metadata read that sends nothing and marks nothing as read. Requires `EVOLUTION_API_URL`, `EVOLUTION_INSTANCE_NAME`, and `EVOLUTION_API_KEY` in `.env.local`. Worth re-running periodically, since groups get renamed.

These are authoritative WhatsApp names, not guesses, so they apply without human approval (unlike `katibe.chat_suggestion`).

**There is no equivalent for `@lid` contacts.** `POST /chat/findContacts` reads Evolution's own `Contact` table, which the dashboard already queries directly, and returns `pushName: null` for them. Baileys can resolve a LID to a phone number internally (`signalRepository.lidMapping.getPNForLID`, used for incoming calls) but Evolution neither exposes it over the API nor persists it — `IsOnWhatsapp.lid` stores the literal string `'lid'`. So `@lid` chats still need either a manual name or an AI suggestion.

## Chat Base (response times)

`/i/[instanceId]/base` reports, per chat, how long the other side waits for us and how long we wait for them, plus how long their newest unanswered message has been sitting there. Both directions come from one pass over consecutive message pairs — a reply is a message whose predecessor came from the opposite side.

Gaps over `MAX_REPLY_GAP_SECONDS` (12h) are treated as a new conversation rather than a very slow reply, so an overnight pause doesn't distort the average. The headline figures are weighted by reply count, so a chat with 200 replies counts more than one with three.

## SLA rules

A rule is a named, reusable policy attached to a **user**, not to an instance. It sets a response-time target chosen by *when the customer's message arrived*, evaluated in the rule's own timezone:

| arrival | target |
| --- | --- |
| a business day, inside the business-hours window | `target_business_minutes` |
| a business day, outside that window | `target_offhours_minutes` |
| a non-business day | `target_weekend_minutes` |

Every number, the window, the set of business days and the timezone are admin-configured per rule (Admin → **⏱️ SLA qaydaları**, `/admin/sla`). Attaching a rule to a person happens on the user screen (Admin → Users).

**The clock does not pause.** An off-hours arrival gets a *longer target*, not a paused timer — a message arriving ten minutes before closing spends its hour after hours. That is what the three separate targets are for; pausing the clock would be a different formula, not a different target.

**A user with no rule is not scored zero — they are not measured.** The instance page shows `—` and says so, because counting "no rule" as "no breaches" would make an unconfigured account look perfect.

### Why the schema is versioned

No response time is stored anywhere: `getWorkloadStats()` recomputes everything from `evolution_api."Message"` on each request. So the danger in editing a rule is not that a saved row gets overwritten — it is that *next week's recomputation of last week* silently uses today's targets. A version counter cannot prevent that; only a validity range the query can join on can.

Hence `katibe.sla_rules` (identity) + `katibe.sla_rule_versions` (immutable rows carrying `[effective_from, effective_to)`). Editing closes the current version at `now()` and opens the next one there. Two Postgres triggers make this real rather than conventional: one rejects any `UPDATE` that touches configuration (only `effective_to` may be set, once) and any `DELETE` of a version belonging to a rule that has ever been used; the other rejects a `timezone` that is not in `pg_timezone_names`, which is why an offset like `+04:00` cannot be stored.

Two conventions keep history intact without asking the admin anything:

- **version 1 starts at `-infinity`** — nothing could have been measured under a rule that did not exist yet, so back-dating is free and lets a new rule cover existing history;
- **a user's first-ever attachment back-dates to their oldest message**, later re-pointing takes effect from `now()`. Same reasoning, and the same shape, as `katibe.user_instances` (see `sql/2026-08-24_assignment_history.sql`).

Deleting follows from that: blocked while anyone is attached (`user_sla_rules.rule_id` is `ON DELETE RESTRICT`, so the database enforces it, not just the UI), retired (`retired_at`) if the rule was used before, and genuinely deleted only if it never was.

### How a measurement resolves

For a customer message that arrived at `t` on instance `i`, `katibe.sla_target_seconds(i, t)` walks four point-in-time steps: instance → its holder at `t` → that user's rule at `t` → that rule's version at `t`. Every step is bounded by a `tstzrange`, so no later edit anywhere in the chain rewrites a past number.

Bucketing uses `t AT TIME ZONE <rule timezone>`, which applies the offset tzdata says was in force *at that instant* — DST-correct by construction, which is why the IANA name is stored and an offset is refused.

One evaluation happens per **response opportunity**: the last message of a run of consecutive customer messages (a five-message burst is one opportunity, not five). It is a breach if the reply came later than the target, or if no reply has come and the target has already elapsed — otherwise ignoring a customer would score better than answering them late.

## Shared contact directory

Names are global by design: `katibe.contact_labels` is keyed by `remote_jid` with no instance column, so naming `994500000001@s.whatsapp.net` once makes it show up under that name on every connected account. `katibe.group_subject` works the same way.

Admin → **📇 Ortaq kontaktlar** (`/admin/contacts`) is where that shared map is viewed and edited, including which accounts each contact actually talks to. Editing a name there resolves any pending AI suggestion for that JID across every instance, since the decision is global.

## Naming rules

A chat's displayed name resolves as: admin label → for groups, `katibe.group_subject` (live subject) → then `Chat.name` for groups / `Contact.pushName` for individuals → the raw JID. Groups must not prefer `Contact.pushName`, because on a group row it holds some participant's personal name rather than the group's. Shared as `nameSql()` in `src/lib/queries.ts` so every table agrees.

The chat list is built from `Chat` rows UNION the JIDs seen in `Message` — Evolution doesn't always write a `Chat` row, and without the union those conversations appear in the stats tables but can't be named.

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
