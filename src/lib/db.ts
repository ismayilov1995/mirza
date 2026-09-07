import { Pool } from "pg";

// Single shared pool. This connects ONLY to Evolution API's own Postgres
// database (already synced by Baileys) and is used strictly for read
// queries (SELECT). It never talks to the WhatsApp connection itself, so
// nothing rendered by this dashboard can ever mark a chat/message as read.
declare global {
  // eslint-disable-next-line no-var
  var _katibePool: Pool | undefined;
}

export const pool =
  global._katibePool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    // One dashboard page fans out to roughly a dozen queries across its
    // Suspense boundaries. At max 5 they queued behind each other and the
    // chat list waited on the stats queries; Postgres allows 100 connections
    // here and fewer than 10 are otherwise in use.
    max: 16,
  });

if (process.env.NODE_ENV !== "production") {
  global._katibePool = pool;
}
