#!/usr/bin/env bash
# Nightly dump of the katibe schema, encrypted at rest with age.
#
# Only katibe is backed up, not evolution_api: Evolution's own tables are a
# cache of WhatsApp and re-sync on their own, whereas katibe holds work that
# exists nowhere else — the names and categories a human typed, the group
# subjects, and AI summaries that cost real money to produce.
#
# Encryption is asymmetric on purpose. Only the *public* key lives on this
# box (/etc/katibe-backup-age.pub), so a compromise of the server yields
# backups nobody can read — not even root here.
#
# The keypair was ROTATED on 2026-08-24, after the first private key was
# printed to a terminal and captured in a session transcript. The current
# recipient is age133vtk83tz220dzs7kgrk30sjcw9xrem6tgyzfwu7qj665mu7dp3qxr0g05.
# Its private key was handed to the operator out of band and deliberately never
# written to this machine. Every backup made under the old key was shredded, so
# the leaked key can no longer decrypt anything that exists.
#
# Restore (needs the private key, from an operator's machine):
#   age -d -i /path/to/age-key.txt katibe-YYYY-MM-DD_HHMM.sql.gz.age \
#     | gunzip | psql "$DATABASE_URL"
#
# Losing that private key means losing every backup here. There is no
# recovery path by design.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${KATIBE_BACKUP_DIR:-/var/backups/katibe}"
KEEP_DAYS="${KATIBE_BACKUP_KEEP_DAYS:-14}"
AGE_RECIPIENT_FILE="${KATIBE_BACKUP_AGE_PUBKEY:-/etc/katibe-backup-age.pub}"

# Offsite replication target, in any form rsync accepts
# (e.g. user@host:/srv/katibe-backups/). Unset means local-only: the backups
# are still encrypted, but a loss of this droplet loses them with it.
OFFSITE_DEST="${KATIBE_BACKUP_OFFSITE_DEST:-}"

# .env.local holds DATABASE_URL; read it without exporting everything else.
DB_URL="$(grep -E '^DATABASE_URL=' "$DIR/.env.local" | head -1 | cut -d= -f2-)"
DB_URL="${DB_URL%%\?*}"   # pg_dump rejects Prisma's ?schema= query parameter
[ -n "$DB_URL" ] || { echo "DATABASE_URL tapılmadı" >&2; exit 1; }

[ -s "$AGE_RECIPIENT_FILE" ] || {
  echo "age public key tapılmadı: $AGE_RECIPIENT_FILE" >&2; exit 1; }

# WHAT IS DELIBERATELY NOT BACKED UP: the embedding vectors.
#
# katibe.chunk and katibe.message_chunk are 4.2 GB of the schema's 6.4 GB, and
# on 2026-08-31 — the day the canonical chunks were built — the nightly dump
# went from 222 MB to 1.4 GB. Fourteen days of retention would have been 20 GB
# of a 58 GB disk, spent on the one thing here that is not original work: the
# vectors are a function of katibe.message, and rebuilding all of them costs
# about $0.15 and one run of scripts/chunk-store.ts.
#
# The TABLES are still dumped, only their DATA is skipped, so a restore comes
# back with the right shape and an empty index that refills itself.
EXCLUDE=(
  --exclude-table-data='katibe.chunk'
  --exclude-table-data='katibe.message_chunk'
)

mkdir -p "$OUT_DIR"
STAMP="$(date +%F_%H%M)"
FILE="$OUT_DIR/katibe-$STAMP.sql.gz.age"

# One pipeline, so the plaintext dump never lands on disk even briefly.
# pipefail (set above) makes a pg_dump or age failure fail the whole run
# rather than leaving a truncated file that looks like a backup.
umask 077
pg_dump "$DB_URL" --schema=katibe --no-owner --no-privileges \
  "${EXCLUDE[@]}" \
  | gzip \
  | age -R "$AGE_RECIPIENT_FILE" > "$FILE"

# A dump that failed mid-stream can still leave a small file behind; refuse to
# count that as a backup.
SIZE=$(stat -c%s "$FILE")
if [ "$SIZE" -lt 1024 ]; then
  echo "Backup çox kiçikdir ($SIZE bayt) — uğursuz sayılır: $FILE" >&2
  exit 1
fi

# Verify the file really is age ciphertext and is structurally intact before
# retention deletes anything. Without the private key we cannot decrypt to
# check the contents, but a truncated or non-age file is still catchable:
# age's header is a fixed magic string.
head -c 21 "$FILE" | grep -q '^age-encryption.org/v1' || {
  echo "Fayl age şifrəli deyil, saxlanılmır: $FILE" >&2; exit 1; }

find "$OUT_DIR" -name 'katibe-*.sql.gz.age' -mtime "+$KEEP_DAYS" -delete

if [ -n "$OFFSITE_DEST" ]; then
  # --delete is deliberately absent: retention is decided here, and a
  # misconfigured destination should never be able to wipe the offsite copy.
  rsync -a --partial "$OUT_DIR"/ "$OFFSITE_DEST"
  echo "$(date -Is) OFFSITE OK -> $OFFSITE_DEST"
else
  echo "$(date -Is) XƏBƏRDARLIQ: offsite hədəf təyin edilməyib (KATIBE_BACKUP_OFFSITE_DEST), yalnız lokal nüsxə var" >&2
fi

echo "$(date -Is) OK $FILE ($((SIZE/1024)) KB), $(ls -1 "$OUT_DIR"/katibe-*.sql.gz.age | wc -l) nüsxə saxlanılır"
