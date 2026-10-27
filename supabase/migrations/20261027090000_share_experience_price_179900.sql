-- ---------------------------------------------------------------------------
-- Migration 20261027090000_share_experience_price_179900
-- Reprices the "Comparte tu experiencia" package of RESET-SUNSET-2026 from COP 509.700 to
-- COP 539.700 total (COP 179.900 per admission) for FUTURE purchases.
--
-- Why a data migration instead of code: the payable amount never comes from the frontend or
-- from a function default. `quote_bundle_order_price` and `create_bundle_order` read
-- `ticket_bundles.price_cents` for the code `SHARE_EXPERIENCE`, and `create_bundle_order`
-- overwrites the order and payment totals from that row inside its own transaction. Updating
-- the row is therefore the single source of truth: the card, the quote and the amount sent to
-- ePayco cannot disagree.
--
-- Unit: `price_cents` is hundredths of a peso, so COP 539.700 is 53970000. One package is three
-- admissions charged ONCE: the total is never multiplied by three a second time, and the
-- per-person figure (53970000 / 3 = 17990000 = COP 179.900) is a display caption only.
--
-- Scope and safety:
--   * Only the active `SHARE_EXPERIENCE` row of event RESET-SUNSET-2026 is touched, matched
--     through its natural key (`ticket_bundles.event_id` + `code`) rather than by row id, so the
--     same migration is correct on any environment that seeded the same catalogue.
--   * `included_admissions` stays 3, the bundle stays on its General `pricing_tier_id`, and
--     `is_active` is not modified. Sales windows and the three-admission reservation from the
--     shared pool of 100 are untouched.
--   * Preventa (COP 159.900), General (COP 199.900) and the retired `DOUBLE_EXPERIENCE` row are
--     separate rows and are not modified.
--   * Historical money is not rewritten: `order_items`, `orders`, `payments`,
--     `checkout_sessions` and the Google Sheets projections store the amounts that were actually
--     quoted or charged. An order created before this migration keeps its own price.
--   * Forward-only and idempotent: the WHERE clause skips a row that already holds the new value,
--     so replaying the migration (or applying it after a manual SQL-editor run) is a no-op rather
--     than an error or a second mutation.
--   * No error is raised when the catalogue is absent (a fresh local database before seeding):
--     the migration then changes nothing and says so. Verification of the staging row is an
--     explicit post-apply check, not an assumption.
-- ---------------------------------------------------------------------------

do $$
declare
  v_updated integer;
begin
  update public.ticket_bundles b
     set price_cents = 53970000
   where b.code = 'SHARE_EXPERIENCE'
     and b.price_cents <> 53970000
     and exists (
       select 1
         from public.events e
        where e.id = b.event_id
          and e.code = 'RESET-SUNSET-2026'
     );

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise notice
      'Share experience price: no RESET-SUNSET-2026 SHARE_EXPERIENCE bundle needed repricing (catalog absent or already at 53970000).';
  else
    raise notice 'Share experience price: % bundle(s) repriced to 53970000.', v_updated;
  end if;
end
$$;
