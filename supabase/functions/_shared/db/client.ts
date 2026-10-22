/**
 * Supabase client factory (server-side only).
 *
 * The backend uses the SECRET key (`sb_secret_*`, or a legacy `service_role` JWT) because
 * it must bypass row level security for its own authoritative writes. That key gives full
 * database authority, so this module must only ever be imported by Edge Functions —
 * never by frontend code. `docs/security.md` records the rule and the review checklist.
 *
 * Types: `Database` is generated from the real migrations by `npm run types:generate`
 * (or, when the local Supabase stack cannot start, by pointing the CLI at a database that
 * has the migrations applied — see docs/phases/phase-02.md). The generated file is never
 * hand-edited and is excluded from formatting and from the root tsconfig on purpose.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BackendConfig } from "../config/env.ts";
import type { Database } from "./database.types.ts";

export type DbClient = SupabaseClient<Database>;

export type CreateDbClientOptions = {
  /** Optional custom fetch, used by integration tests to stub the database. */
  readonly fetchImpl?: typeof globalThis.fetch;
};

/**
 * Creates a Supabase client with service-role authority.
 *
 * Session persistence is disabled: this client is stateless, one per request/worker,
 * and must never hold a user session.
 */
export function createServiceRoleClient(
  config: BackendConfig,
  options: CreateDbClientOptions = {},
): DbClient {
  // `loadConfig` has already rejected publishable/anon keys; this is the last line of
  // defence in case a config object is constructed by hand anywhere else.
  if (
    config.supabase.keyKind === "legacy_service_role_jwt" &&
    config.supabase.secretKey.startsWith("sb_publishable_")
  ) {
    throw new Error("Refusing to create a privileged database client with a publishable key");
  }

  return createClient<Database>(config.supabase.url, config.supabase.secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-application-name": config.serviceName },
      ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
    },
  });
}
