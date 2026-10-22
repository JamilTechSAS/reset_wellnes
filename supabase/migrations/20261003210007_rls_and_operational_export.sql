-- ---------------------------------------------------------------------------
-- Migration 20261003210007_rls_and_operational_export
-- Phase 2 / part 7 of 7: row level security posture and the operational read model.
--
-- RLS posture (deliberate, documented in docs/security.md):
--   * RLS is enabled on EVERY domain table and NO policy is created. For any role that
--     does not bypass RLS (anon, authenticated, and any future API role) the tables are
--     therefore unreadable and unwritable by construction.
--   * The backend uses the secret key (service_role semantics, BYPASSRLS). It does not
--     need policies; it needs the guarantee that a publishable key reads nothing even if
--     the future frontend is misconfigured.
--   * Defense in depth: the browser-facing roles additionally lose their default table
--     privileges, and new tables in `public` start without those grants. If a table ever
--     needs direct PostgREST access, that is an explicit grant + policies decision.
--   * Policies will be added only when a real client-facing path requires them, and only
--     for the specific columns/rows that path needs (docs/api.md).
--
-- operational_export:
--   * Read model for the Google Sheets sync (docs/operations-google-sheets.md). It joins
--     ticket + participant + order + payment + attendance + consents and exposes exactly
--     the columns the operations team needs — adding one is a deliberate migration.
--   * It contains personal data (cédula, email, phone). It is NOT a write interface and
--     never exposed with the publishable key.
--   * Raw values (enum statuses, centavos, timestamptz) are exported as-is; the Spanish
--     labels/formatting live in the Phase 1 label maps and are applied by the export
--     function (Phase 10). One formatting implementation, not two.
--   * `security_invoker = true`: the view runs with the caller's privileges, so granting
--     it to a role that has no rights on the base tables fails closed instead of leaking
--     participant data.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Row level security: enabled everywhere, no policies anywhere
-- ---------------------------------------------------------------------------
alter table public.events enable row level security;
alter table public.ticket_types enable row level security;
alter table public.pricing_tiers enable row level security;
alter table public.quantity_discounts enable row level security;
alter table public.discount_codes enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.discount_redemptions enable row level security;
alter table public.participants enable row level security;
alter table public.tickets enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.attendance enable row level security;
alter table public.consents enable row level security;
alter table public.email_deliveries enable row level security;

-- ---------------------------------------------------------------------------
-- operational_export
-- ---------------------------------------------------------------------------
create view public.operational_export
with (security_invoker = true)
as
select
  e.code as "Evento",
  t.token as "Código de entrada",
  p.first_name as "Nombre",
  p.last_name as "Apellido",
  p.national_id as "Cédula",
  p.email as "Correo",
  p.phone as "Teléfono",
  p.city as "Ciudad",
  p.instagram as "Instagram",
  tt.name as "Tipo de entrada",
  pt.name as "Etapa de venta",
  t.price_paid_cents as "Precio centavos",
  o.currency as "Moneda",
  o.reference as "Referencia de la orden",
  o.status as "Estado de la orden",
  pay.status as "Estado del pago",
  pay.raw_wompi_status as "Estado Wompi",
  t.status as "Estado de la entrada",
  (a.id is not null) as "Ingreso",
  a.checked_in_at as "Fecha de ingreso",
  dp.granted as "Autorización de datos",
  dp.policy_version as "Autorización de datos versión",
  dp.captured_at as "Autorización de datos fecha",
  fe.granted as "Autorización próximos eventos",
  t.created_at as "Creada"
from public.tickets t
join public.events e
  on e.id = t.event_id
join public.orders o
  on o.id = t.order_id
join public.ticket_types tt
  on tt.id = t.ticket_type_id
join public.order_items oi
  on oi.id = t.order_item_id
join public.pricing_tiers pt
  on pt.id = oi.pricing_tier_id
-- LEFT JOIN: a ticket may exist before its participant is assigned; it must still appear
-- in the operational counts.
left join public.participants p
  on p.id = t.participant_id
left join public.attendance a
  on a.ticket_id = t.id
-- Latest meaningful payment attempt: the approved one when it exists, otherwise the most
-- recent attempt (so declined/voided is visible instead of an empty cell).
left join lateral (
  select p2.status, p2.raw_wompi_status
    from public.payments p2
   where p2.order_id = t.order_id
   order by (p2.status = 'approved') desc, p2.attempt desc
   limit 1
) pay on true
-- Effective consent decisions: latest row per (participant, kind).
left join lateral (
  select c.granted, c.policy_version, c.captured_at
    from public.consents c
   where c.participant_id = p.id
     and c.kind = 'DATA_PROCESSING'
   order by c.captured_at desc, c.id desc
   limit 1
) dp on true
left join lateral (
  select c.granted
    from public.consents c
   where c.participant_id = p.id
     and c.kind = 'FUTURE_EVENTS'
   order by c.captured_at desc, c.id desc
   limit 1
) fe on true
order by t.created_at, t.id;

comment on view public.operational_export is
  'Operational read model for the Google Sheets sync: one row per ticket with participant, order, payment, attendance and consent data. Contains personal data; readable only by the service role. Read-only and not a write interface.';

-- ---------------------------------------------------------------------------
-- Defense in depth: remove default grants from the browser-facing roles
-- ---------------------------------------------------------------------------
do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'events',
    'ticket_types',
    'pricing_tiers',
    'quantity_discounts',
    'discount_codes',
    'orders',
    'order_items',
    'discount_redemptions',
    'participants',
    'tickets',
    'payments',
    'payment_events',
    'attendance',
    'consents',
    'email_deliveries'
  ]
  loop
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on table public.%I from %I', table_name, role_name);
      end if;
    end loop;
  end loop;

  -- The order reference sequence must not be readable/usable by the API roles either.
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on sequence public.order_reference_seq from %I', role_name);
    end if;
  end loop;

  -- The export view is personal data: browser-facing roles never read it.
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table public.operational_export from %I', role_name);
    end if;
  end loop;
end
$$;

-- New tables (and views) in `public` start without grants for the browser-facing roles.
-- Anything that needs direct PostgREST access must be granted deliberately.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke all on tables from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter default privileges in schema public revoke all on tables from authenticated';
  end if;
end
$$;

-- The backend's own identity gets read access to the export view explicitly (it already
-- has it through its broad privileges; this makes the dependency visible and reviewable).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.operational_export to service_role';
  end if;
end
$$;
