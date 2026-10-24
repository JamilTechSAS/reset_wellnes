-- -----------------------------------------------------------------------------
-- Migration 20261024140000_order_status_admissions
--
-- The buyer-facing order projection still described the ticket era: it returned
-- an (always empty) `tickets` array and an email `confirmation` count keyed by
-- ticket ids. Tickets are discontinued, so those fields carried no information
-- and the frontend could not tell whether the companion of a two-admission
-- purchase had already been attached — after a refresh it offered the companion
-- form again and relied on a PT409 to learn the order was complete.
--
-- This migration replaces them with the order's own admission roster:
--   * admissions.quantity           sum(order_items.quantity), the same capacity
--                                   confirm_payment and attach_participant use,
--   * admissions.assigned           participant rows on the order (create_order
--                                   writes the buyer's own row, so unit 1 is
--                                   already assigned),
--   * admissions.remainingUnassigned greatest(quantity - assigned, 0),
--   * participants[]                 { unit, firstName, lastName } only, in
--                                   attachment order (unit 1 = the holder).
--
-- Privacy: the roster is names only. Cédula, email, phone, city, Instagram and
-- the participant id are never projected, and the roster is returned only for a
-- PAID order (there is nothing to show — and nothing to attach — before that).
-- The reference+email possession gate is unchanged: an unknown reference and a
-- wrong email still return the same `found:false`.
--
-- Ticket-related tables remain in place for legacy data, but nothing in this
-- projection reads them any more.
-- -----------------------------------------------------------------------------

create or replace function public.get_order_status(
  p_order_reference text,
  p_buyer_email text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $status$
declare
  v_order public.orders;
  v_attempts jsonb := '[]'::jsonb;
  v_participants jsonb := '[]'::jsonb;
  v_payment public.payments;
  v_quantity integer := 0;
  v_assigned integer := 0;
begin
  select * into v_order
  from public.orders
  where reference = btrim(coalesce(p_order_reference, ''))
    and buyer_email = lower(btrim(coalesce(p_buyer_email, '')));
  if v_order.id is null then
    return jsonb_build_object('found', false);
  end if;

  select coalesce(sum(oi.quantity), 0)::integer into v_quantity
    from public.order_items oi where oi.order_id = v_order.id;

  select count(*)::integer into v_assigned
    from public.participants p where p.order_id = v_order.id;

  select * into v_payment
    from public.payments
   where order_id = v_order.id
   order by attempt desc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'attempt', p.attempt,
           'status', p.status,
           'provider', coalesce(p.payment_provider, 'epayco'),
           'reference', coalesce(p.provider_reference, p.wompi_reference),
           'wompiReference', p.wompi_reference,
           'amountInCents', p.amount_cents,
           'statusMessage', p.status_message,
           'createdAt', to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'finalizedAt', to_char(p.finalized_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) order by p.attempt), '[]'::jsonb)
    into v_attempts
    from public.payments p
   where p.order_id = v_order.id;

  -- Names only, numbered in attachment order. The order row is written with the
  -- buyer's own participant, and attach_participant appends under the same
  -- ordering, so `unit` matches the ordinal that endpoint reports.
  if v_order.status = 'PAID' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'unit', r.unit,
             'firstName', r.first_name,
             'lastName', r.last_name
           ) order by r.unit), '[]'::jsonb)
      into v_participants
      from (
        select p.first_name,
               p.last_name,
               row_number() over (order by p.created_at, p.id)::integer as unit
          from public.participants p
         where p.order_id = v_order.id
      ) r;
  end if;

  return jsonb_build_object(
    'found', true,
    'reference', v_order.reference,
    'status', v_order.status,
    'quantity', v_quantity,
    'currency', v_order.currency,
    'subtotalInCents', v_order.subtotal_cents,
    'quantityDiscountInCents', v_order.quantity_discount_cents,
    'discountCodeInCents', v_order.discount_code_cents,
    'totalInCents', v_order.total_cents,
    'createdAt', to_char(v_order.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'paidAt', to_char(v_order.paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'reservationExpiresAt', to_char(v_order.reservation_expires_at at time zone 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'attempt', v_payment.attempt,
      'status', v_payment.status,
      'provider', coalesce(v_payment.payment_provider, 'epayco'),
      'reference', coalesce(v_payment.provider_reference, v_payment.wompi_reference),
      'methodType', v_payment.payment_method_type,
      'statusMessage', v_payment.status_message,
      'approvedAt', to_char(v_payment.approved_at at time zone 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) end,
    'paymentAttempts', v_attempts,
    'admissions', jsonb_build_object(
      'quantity', v_quantity,
      'assigned', v_assigned,
      'remainingUnassigned', greatest(v_quantity - v_assigned, 0)
    ),
    'participants', v_participants
  );
end;
$status$;

comment on function public.get_order_status(text, text) is
  'Buyer-facing order projection: reference+email ownership is required, only whitelisted fields are returned, and the admission roster carries names only (unit 1 = holder). Ticket-era fields (tickets, email confirmation) are gone; admissions.remainingUnassigned drives the companion form.';

-- `create or replace` preserves the existing ACL (revoked from PUBLIC/anon/
-- authenticated, granted to service_role), so no re-grant is needed here.
