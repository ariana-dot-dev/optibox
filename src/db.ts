import { Pool, type PoolClient } from "pg";

/**
 * THE state layer. Every piece of coordination state — users, boxes, billing,
 * turns, holds, hosting, sessions, transcripts, templates — lives in Postgres
 * and nowhere else. No in-memory maps, no name-based inference, no promise
 * plumbing between callers: processes coordinate through rows and advisory
 * locks, so restarts are not amnesia and N processes are safe by construction.
 * (docs/redesign.md is the contract; the 2026-07-09/10 incident log is the
 * reason.)
 */

export const SCHEMA = `
create table if not exists instances (
  id text primary key,
  heartbeat_at timestamptz not null default now()
);
create table if not exists users (
  key text primary key,
  billed_seconds double precision not null default 0,
  last_activity_at timestamptz not null default now()
);
create table if not exists boxes (
  id text primary key,
  user_key text not null,
  instance_id text not null,
  purpose text not null check (purpose in ('user','template')),
  billing_since timestamptz,
  billing_reason text,
  retired_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists one_active_user_box on boxes(user_key)
  where purpose = 'user' and retired_at is null;
create table if not exists conversations (
  user_key text not null,
  id text not null,
  harness_sessions jsonb not null default '{}',
  primary key (user_key, id)
);
create table if not exists transcripts (
  seq bigserial primary key,
  user_key text not null,
  conversation_id text not null,
  role text not null,
  content text not null,
  mode text,
  at timestamptz not null default now()
);
create index if not exists transcripts_conv on transcripts(user_key, conversation_id, seq);
create table if not exists turns (
  id text primary key,
  user_key text not null,
  conversation_id text not null,
  message text not null,
  fingerprint text not null,
  status text not null check (status in ('active','answered','suppressed','blocked','interrupted')),
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists turns_conv on turns(user_key, conversation_id, created_at);
create table if not exists holds (
  user_key text not null,
  reason text not null,
  expires_at timestamptz not null,
  primary key (user_key, reason)
);
create table if not exists hosting (
  user_key text not null,
  port int not null,
  conversation_id text not null,
  box_id text not null,
  mode text not null check (mode in ('public','private')),
  url text,
  started_at timestamptz not null default now(),
  stop_requested_at timestamptz,
  misses int not null default 0,
  primary key (user_key, port)
);
create table if not exists templates (
  instance_id text primary key,
  box_id text not null,
  status text not null check (status in ('building','ready','failed')),
  built_at timestamptz
);
-- UI render journal: the ordered stream of events the client rendered for a
-- conversation, stored verbatim so reopening the app REPLAYS it through the very
-- same handle() renderer and the chat + tool chains + attachments + desktop come
-- back exactly as they were — including whatever the agent did while the tab was
-- closed (turns run to completion server-side regardless of the connection).
-- Distinct from transcripts, which is the CLEANED model-context projection; this
-- is the raw "what was on screen". body is the ConsumerTurnEvent (or a synthetic
-- user.message). seq gives the total render order and the resume cursor.
create table if not exists events (
  seq bigserial primary key,
  user_key text not null,
  conversation_id text not null,
  turn_id text,
  body jsonb not null,
  at timestamptz not null default now()
);
create index if not exists events_conv on events(user_key, conversation_id, seq);
`;

export interface Db {
  pool: Pool;
  q<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R[]>;
  one<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R | undefined>;
  /**
   * Cross-process mutex via a session-scoped advisory lock held on a dedicated
   * connection for the duration of fn. Two lock classes exist in the system:
   * ('user', userKey) — box lifecycle (ensure/stop/sweep) — and
   * ('conv', userKey:convId) — box-round ordering within a conversation.
   */
  withLock<T>(cls: "user" | "conv", key: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(connectionString: string): Promise<Db> {
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000 });
  await pool.query(SCHEMA);
  const q = async <R,>(text: string, params: unknown[] = []): Promise<R[]> =>
    (await pool.query(text, params)).rows as R[];
  const one = async <R,>(text: string, params: unknown[] = []): Promise<R | undefined> =>
    ((await pool.query(text, params)).rows as R[])[0];
  const withLock = async <T,>(cls: "user" | "conv", key: string, fn: () => Promise<T>): Promise<T> => {
    // Dedicated client: session advisory locks belong to a connection, and the
    // work inside fn may run arbitrary pool queries — the lock must not ride
    // one of those. hashtext gives the int pair the advisory API needs.
    const client: PoolClient = await pool.connect();
    try {
      await client.query("select pg_advisory_lock(hashtext($1), hashtext($2))", [cls, key]);
      try {
        return await fn();
      } finally {
        await client.query("select pg_advisory_unlock(hashtext($1), hashtext($2))", [cls, key]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  };
  return { pool, q, one, withLock, close: () => pool.end() };
}

/** Read DATABASE_URL loudly — no fallback (spec: crash loudly). */
export function databaseUrlFromEnv(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (postgres://... — see docs/redesign.md)");
  return url;
}
