-- ---------------------------------------------------------------------------
-- Migration 20261024220000_preventa_price_159900
-- Reprices the active Preventa stage of RESET-SUNSET-2026 from COP 160.000 to
-- COP 159.900 for FUTURE purchases.
--
-- Why a data migration instead of code: the payable amount never comes from the frontend or
-- from a function default. `create_quote` and `create_order` both read
-- `pricing_tiers.price_cents` for the stage resolved by `app_private.active_pricing_tier_id`,
-- and `create_order` locks that row inside the ordering transaction. Updating the row is
-- therefore the single source of truth: the catalog, the quote and the charge cannot disagree.
--
-- Unit: `price_cents` is hundredths of a peso (COP 160.000 = 16000000), so COP 159.900 is
-- 15990000. The value keeps the same scale as every other tier in the table.
--
-- Scope and safety:
--   * Only the Preventa stage (sequence 1) of ticket type GENERAL in event RESET-SUNSET-2026 is
--     touched, matched through its catalog keys rather than by row id, so the same migration is
--     correct on any environment that seeds the same catalog.
--   * Sales windows, `quantity_limit`, `max_per_order` (Preventa keeps its one-admission cap),
--     `is_active` and both inventory counters are left exactly as they are.
--   * `ticket_bundles` (DOUBLE_EXPERIENCE, COP 340.000) and the General stage (COP 200.000) are
--     separate rows and are not modified.
--   * Historical money is not rewritten: `order_items`, `orders`, `payments`, `checkout_sessions`
--     and the Google Sheets projections store the amounts that were actually quoted or charged.
--     An order created before this migration keeps its own price.
--   * Forward-only and idempotent: the WHERE clause skips a row that already holds the new
--     value, so replaying the migration (or applying it after a manual SQL Editor run) is a
--     no-op rather than an error or a second mutation.
--   * No error is raised when the catalog is absent (a fresh local database before seeding):
--     the migration then changes nothing and says so. Verification of the staging row is an
--     explicit post-apply check, not an assumption.
-- ---------------------------------------------------------------------------

do $$
declare
  v_updated integer;
begin
  update public.pricing_tiers t
     set price_cents = 15990000
   where t.name = 'Preventa'
     and t.sequence = 1
     and t.price_cents <> 15990000
     and exists (
       select 1
         from public.ticket_types tt
         join public.events e on e.id = tt.event_id
        where tt.id = t.ticket_type_id
          and tt.code = 'GENERAL'
          and e.code = 'RESET-SUNSET-2026'
     );

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise notice
      'Preventa price: no RESET-SUNSET-2026 Preventa tier needed repricing (catalog absent or already at 15990000).';
  else
    raise notice 'Preventa price: % tier(s) repriced to 15990000.', v_updated;
  end if;
end
$$;
