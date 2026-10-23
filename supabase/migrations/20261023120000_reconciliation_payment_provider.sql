-- ---------------------------------------------------------------------------
-- Migration 20261023120000_reconciliation_payment_provider
-- H4: provider-aware payment reconciliation.
--
-- `claim_payment_reconciliations` was written for Wompi only: it returned no provider, so the
-- sweep queried Wompi for every pending attempt, including ePayco ones (whose ref_payco
-- `confirm_payment` also stores in `wompi_transaction_id`). The claimed row now carries
-- `paymentProvider` and the provider-neutral `providerTransactionId`, so the sweep routes each
-- attempt to its own provider and never sends one provider's transaction to the other.
--
-- Same signature, same candidate rules, same locking and scheduling; only the candidate's
-- transaction-id test is provider-neutral and two keys are added to the returned object.
-- `create or replace` with an unchanged signature keeps the existing grants
-- (20261003210012, 20261004140000).
-- ---------------------------------------------------------------------------

create or replace function public.claim_payment_reconciliations(
  p_limit integer default 10,
  p_max_attempts integer default 8,
  p_now timestamptz default now()
)
returns setof jsonb
language plpgsql
security invoker
set search_path = ''
as $claimrecon$
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Reconciliation batch limit must be between 1 and 50'
      using errcode = 'PT400', detail = 'INVALID_LIMIT';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Reconciliation max attempts must be between 1 and 20'
      using errcode = 'PT400', detail = 'INVALID_MAX_ATTEMPTS';
  end if;

  return query
  with candidate as (
    select p.id
      from public.payments p
      join public.orders o on o.id = p.order_id
     where p.status in ('pending'::public.payment_status, 'unknown'::public.payment_status)
       -- Only attempts whose transaction id is known can be queried at their provider.
       and coalesce(p.provider_transaction_id, p.wompi_transaction_id) is not null
       and p.next_reconciliation_at is not null
       and p.next_reconciliation_at <= p_now
       and p.reconciliation_attempts < p_max_attempts
       -- PAID is excluded on purpose: a second approval would violate the
       -- one-approved-payment-per-order index, and the webhook path records those
       -- deliveries already. Everything else (including EXPIRED/CANCELLED) is safe:
       -- confirm_payment turns a late approval into RECONCILIATION_REQUIRED.
       and o.status in ('PENDING', 'FAILED', 'EXPIRED', 'CANCELLED')
     order by p.next_reconciliation_at
     limit p_limit
     for update of p skip locked
  ),
  claimed as (
    update public.payments p
       set reconciliation_attempts = p.reconciliation_attempts + 1,
           last_reconciled_at = p_now,
           next_reconciliation_at = p_now + make_interval(
             secs => app_private.reconciliation_delay_seconds(p.reconciliation_attempts + 1)
           )
      from candidate c
     where p.id = c.id
    returning p.*
  )
  select jsonb_build_object(
           'paymentId', c.id,
           'orderId', c.order_id,
           'paymentAttempt', c.attempt,
           'paymentProvider', c.payment_provider,
           'wompiReference', c.wompi_reference,
           'wompiTransactionId', c.wompi_transaction_id,
           'providerTransactionId', coalesce(c.provider_transaction_id, c.wompi_transaction_id),
           'paymentStatus', c.status,
           'amountCents', c.amount_cents,
           'currency', c.currency,
           'reconciliationAttempts', c.reconciliation_attempts,
           'orderReference', o.reference,
           'orderStatus', o.status,
           'orderTotalInCents', o.total_cents,
           'orderCurrency', o.currency
         )
    from claimed c
    join public.orders o on o.id = c.order_id;
end;
$claimrecon$;

comment on function public.claim_payment_reconciliations(integer, integer, timestamptz) is
  'Claims up to p_limit pending payment attempts that are due for a provider sweep (known transaction id, attempt count below p_max_attempts, non-paid order) and advances their schedule. Each row carries paymentProvider so the sweep queries the attempt''s own provider. FOR UPDATE SKIP LOCKED makes concurrent runs split the work; the attempt budget bounds the total number of queries.';
