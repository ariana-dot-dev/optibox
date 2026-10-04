import { Pool, type PoolClient } from "pg";

/**
 * THE state layer. Every piece of coordination state — users, sandboxes, billing,
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
-- 2026-10-04 rename Box -> Boat: the machine is a "sandbox". Carry a database made
-- under the old names over in place (idempotent: each step runs only while the old
-- name still exists), so no user, conversation or billing row is lost.
do $$ begin
  if to_regclass('public.boxes') is not null and to_regclass('public.sandboxes') is null then
    alter table boxes rename to sandboxes;
  end if;
  if to_regclass('public.one_active_user_box') is not null then
    alter index one_active_user_box rename to one_active_user_sandbox;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'conversations' and column_name = 'box_conversations')
     and not exists (select 1 from information_schema.columns where table_name = 'conversations' and column_name = 'sandbox_conversations') then
    alter table conversations rename column box_conversations to sandbox_conversations;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'hosting' and column_name = 'box_id') then
    alter table hosting rename column box_id to sandbox_id;
  end if;
  -- the render journal replays old events: give them the new event names and keys
  if to_regclass('public.events') is not null then
    update events set body = replace(replace(replace(replace(body::text,
      '"user-box.delta"', '"user-sandbox.delta"'), '"boxId"', '"sandboxId"'), '"user-box"', '"user-sandbox"'), '"shared-box"', '"shared-sandbox"')::jsonb
    where body::text like '%"user-box%' or body::text like '%"boxId"%' or body::text like '%"shared-box"%';
  end if;
end $$;
-- provider_env / agent_files / agent_selection: the user's OWN Agents setup —
-- the provider keys their sandbox runs on, the home-relative secret files written
-- into it after every bring-up (a no-env sandbox's resume scrubs them off disk), and
-- their default harness/model. env_pending marks keys saved while the sandbox was
-- parked: the next resume passes them as the sandbox's new env.
create table if not exists users (
  key text primary key,
  billed_seconds double precision not null default 0,
  last_activity_at timestamptz not null default now()
);
alter table users add column if not exists provider_env jsonb not null default '{}';
alter table users add column if not exists agent_files jsonb not null default '{}';
alter table users add column if not exists agent_selection jsonb not null default '{}';
alter table users add column if not exists env_pending boolean not null default false;
-- agent_oauth: the half of a connected subscription the sandbox never sees, per
-- provider ({"claude":{"refreshToken":…,"expiresAt":…}}). The access token
-- itself lives in provider_env / agent_files because that is what the sandbox runs
-- on; the refresh token stays here and is spent just before a bring-up.
alter table users add column if not exists agent_oauth jsonb not null default '{}';
create table if not exists sandboxes (
  id text primary key,
  user_key text not null,
  instance_id text not null,
  purpose text not null check (purpose in ('user','template','scenario','checkpoint')),
  billing_since timestamptz,
  billing_reason text,
  retired_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists one_active_user_sandbox on sandboxes(user_key)
  where purpose = 'user' and retired_at is null;
-- sandbox_conversations: {"<sandboxId>": "<sandbox conversation id>"} — the Boat keeps the memory,
-- we keep the pointer (a fresh machine starts a fresh conversation).
create table if not exists conversations (
  user_key text not null,
  id text not null,
  sandbox_conversations jsonb not null default '{}',
  primary key (user_key, id)
);
alter table conversations add column if not exists sandbox_conversations jsonb not null default '{}';
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
  sandbox_id text not null,
  mode text not null check (mode in ('public','private')),
  url text,
  started_at timestamptz not null default now(),
  stop_requested_at timestamptz,
  misses int not null default 0,
  primary key (user_key, port)
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
-- Parallel scenarios run as parallel conversations on the user's own sandbox; their
-- transcripts carry scenario_id so they stay out of the main-line model context.
alter table transcripts add column if not exists scenario_id text;
`;

export interface Db {
  pool: Pool;
  q<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R[]>;
  one<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R | undefined>;
  /**
   * Cross-process mutex via a session-scoped advisory lock held on a dedicated
   * connection for the duration of fn. Two lock classes exist in the system:
   * ('user', userKey) — sandbox lifecycle (ensure/stop/sweep) — and
   * ('conv', userKey:convId) — sandbox-round ordering within a conversation.
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
