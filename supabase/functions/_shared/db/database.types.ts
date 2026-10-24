
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "attendance": {
                  Row: {
                    "checked_in_at": string,"checked_in_by": string,"checked_in_by_user_id": string | null,"created_at": string,"event_id": string,"id": string,"method": string,"notes": string | null,"ticket_id": string
                  }
                  Insert: {
                    "checked_in_at"?: string,"checked_in_by": string,"checked_in_by_user_id"?: string | null,"created_at"?: string,"event_id": string,"id"?: string,"method"?: string,"notes"?: string | null,"ticket_id": string
                  }
                  Update: {
                    "checked_in_at"?: string,"checked_in_by"?: string,"checked_in_by_user_id"?: string | null,"created_at"?: string,"event_id"?: string,"id"?: string,"method"?: string,"notes"?: string | null,"ticket_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attendance_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attendance_ticket_id_fkey"
      columns: ["ticket_id"]
isOneToOne: true
      referencedRelation: "tickets"
      referencedColumns: ["id"]
    }
                  ]
                },"consents": {
                  Row: {
                    "captured_at": string,"created_at": string,"event_id": string,"granted": boolean,"id": string,"ip_address": unknown,"kind": Database["public"]['Enums']["consent_kind"],"participant_id": string,"policy_text_hash": string | null,"policy_version": string
                  }
                  Insert: {
                    "captured_at"?: string,"created_at"?: string,"event_id": string,"granted": boolean,"id"?: string,"ip_address"?: unknown,"kind": Database["public"]['Enums']["consent_kind"],"participant_id": string,"policy_text_hash"?: string | null,"policy_version": string
                  }
                  Update: {
                    "captured_at"?: string,"created_at"?: string,"event_id"?: string,"granted"?: boolean,"id"?: string,"ip_address"?: unknown,"kind"?: Database["public"]['Enums']["consent_kind"],"participant_id"?: string,"policy_text_hash"?: string | null,"policy_version"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "consents_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "consents_participant_id_fkey"
      columns: ["participant_id"]
isOneToOne: false
      referencedRelation: "participants"
      referencedColumns: ["id"]
    }
                  ]
                },"discount_codes": {
                  Row: {
                    "amount_cents": number | null,"code": string,"created_at": string,"currency": string,"event_id": string,"id": string,"is_active": boolean,"kind": Database["public"]['Enums']["discount_kind"],"max_redemptions": number | null,"min_quantity": number,"percent_bps": number | null,"redeemed_count": number,"ticket_type_id": string | null,"updated_at": string,"valid_from": string | null,"valid_until": string | null
                  }
                  Insert: {
                    "amount_cents"?: number | null,"code": string,"created_at"?: string,"currency"?: string,"event_id": string,"id"?: string,"is_active"?: boolean,"kind": Database["public"]['Enums']["discount_kind"],"max_redemptions"?: number | null,"min_quantity"?: number,"percent_bps"?: number | null,"redeemed_count"?: number,"ticket_type_id"?: string | null,"updated_at"?: string,"valid_from"?: string | null,"valid_until"?: string | null
                  }
                  Update: {
                    "amount_cents"?: number | null,"code"?: string,"created_at"?: string,"currency"?: string,"event_id"?: string,"id"?: string,"is_active"?: boolean,"kind"?: Database["public"]['Enums']["discount_kind"],"max_redemptions"?: number | null,"min_quantity"?: number,"percent_bps"?: number | null,"redeemed_count"?: number,"ticket_type_id"?: string | null,"updated_at"?: string,"valid_from"?: string | null,"valid_until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "discount_codes_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "discount_codes_ticket_type_id_fkey"
      columns: ["ticket_type_id"]
isOneToOne: false
      referencedRelation: "ticket_types"
      referencedColumns: ["id"]
    }
                  ]
                },"discount_redemptions": {
                  Row: {
                    "amount_cents": number,"created_at": string,"discount_code_id": string,"id": string,"order_id": string
                  }
                  Insert: {
                    "amount_cents": number,"created_at"?: string,"discount_code_id": string,"id"?: string,"order_id": string
                  }
                  Update: {
                    "amount_cents"?: number,"created_at"?: string,"discount_code_id"?: string,"id"?: string,"order_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "discount_redemptions_discount_code_id_fkey"
      columns: ["discount_code_id"]
isOneToOne: false
      referencedRelation: "discount_codes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "discount_redemptions_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"email_deliveries": {
                  Row: {
                    "attempt_count": number,"created_at": string,"id": string,"idempotency_key": string,"last_error": string | null,"next_attempt_at": string | null,"provider": string,"provider_message_id": string | null,"queued_at": string,"recipient_email": string,"sent_at": string | null,"status": Database["public"]['Enums']["email_delivery_status"],"template": string,"ticket_id": string,"updated_at": string
                  }
                  Insert: {
                    "attempt_count"?: number,"created_at"?: string,"id"?: string,"idempotency_key": string,"last_error"?: string | null,"next_attempt_at"?: string | null,"provider"?: string,"provider_message_id"?: string | null,"queued_at"?: string,"recipient_email": string,"sent_at"?: string | null,"status"?: Database["public"]['Enums']["email_delivery_status"],"template": string,"ticket_id": string,"updated_at"?: string
                  }
                  Update: {
                    "attempt_count"?: number,"created_at"?: string,"id"?: string,"idempotency_key"?: string,"last_error"?: string | null,"next_attempt_at"?: string | null,"provider"?: string,"provider_message_id"?: string | null,"queued_at"?: string,"recipient_email"?: string,"sent_at"?: string | null,"status"?: Database["public"]['Enums']["email_delivery_status"],"template"?: string,"ticket_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_deliveries_ticket_id_fkey"
      columns: ["ticket_id"]
isOneToOne: false
      referencedRelation: "tickets"
      referencedColumns: ["id"]
    }
                  ]
                },"events": {
                  Row: {
                    "capacity": number | null,"city": string | null,"code": string,"created_at": string,"currency": string,"description": string | null,"ends_at": string | null,"id": string,"name": string,"starts_at": string,"status": Database["public"]['Enums']["event_status"],"timezone": string,"updated_at": string,"venue_address": string | null,"venue_name": string | null
                  }
                  Insert: {
                    "capacity"?: number | null,"city"?: string | null,"code": string,"created_at"?: string,"currency"?: string,"description"?: string | null,"ends_at"?: string | null,"id"?: string,"name": string,"starts_at": string,"status"?: Database["public"]['Enums']["event_status"],"timezone"?: string,"updated_at"?: string,"venue_address"?: string | null,"venue_name"?: string | null
                  }
                  Update: {
                    "capacity"?: number | null,"city"?: string | null,"code"?: string,"created_at"?: string,"currency"?: string,"description"?: string | null,"ends_at"?: string | null,"id"?: string,"name"?: string,"starts_at"?: string,"status"?: Database["public"]['Enums']["event_status"],"timezone"?: string,"updated_at"?: string,"venue_address"?: string | null,"venue_name"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"operators": {
                  Row: {
                    "created_at": string,"display_name": string,"is_active": boolean,"role": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"display_name": string,"is_active"?: boolean,"role"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string,"is_active"?: boolean,"role"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"order_items": {
                  Row: {
                    "created_at": string,"id": string,"bundle_id": string | null,"line_total_cents": number,"order_id": string,"pricing_tier_id": string,"pricing_tier_name": string,"quantity": number,"quantity_discount_cents": number,"ticket_type_id": string,"ticket_type_name": string,"unit_price_cents": number,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"bundle_id"?: string | null,"line_total_cents": number,"order_id": string,"pricing_tier_id": string,"pricing_tier_name": string,"quantity": number,"quantity_discount_cents"?: number,"ticket_type_id": string,"ticket_type_name": string,"unit_price_cents": number,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"bundle_id"?: string | null,"line_total_cents"?: number,"order_id"?: string,"pricing_tier_id"?: string,"pricing_tier_name"?: string,"quantity"?: number,"quantity_discount_cents"?: number,"ticket_type_id"?: string,"ticket_type_name"?: string,"unit_price_cents"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "order_items_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "order_items_pricing_tier_id_fkey"
      columns: ["pricing_tier_id"]
isOneToOne: false
      referencedRelation: "pricing_tiers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "order_items_ticket_type_id_fkey"
      columns: ["ticket_type_id"]
isOneToOne: false
      referencedRelation: "ticket_types"
      referencedColumns: ["id"]
    }
                  ]
                },"orders": {
                  Row: {
                    "buyer_email": string,"buyer_name": string | null,"buyer_phone": string | null,"cancelled_at": string | null,"created_at": string,"currency": string,"discount_code_cents": number,"discount_code_id": string | null,"event_id": string,"failed_at": string | null,"id": string,"idempotency_key": string | null,"ip_address": unknown,"notes": string | null,"paid_at": string | null,"quantity_discount_cents": number,"reference": string,"reservation_expires_at": string | null,"source": string,"status": Database["public"]['Enums']["order_status"],"subtotal_cents": number,"total_cents": number,"updated_at": string,"user_agent": string | null
                  }
                  Insert: {
                    "buyer_email": string,"buyer_name"?: string | null,"buyer_phone"?: string | null,"cancelled_at"?: string | null,"created_at"?: string,"currency"?: string,"discount_code_cents"?: number,"discount_code_id"?: string | null,"event_id": string,"failed_at"?: string | null,"id"?: string,"idempotency_key"?: string | null,"ip_address"?: unknown,"notes"?: string | null,"paid_at"?: string | null,"quantity_discount_cents"?: number,"reference": string,"reservation_expires_at"?: string | null,"source"?: string,"status"?: Database["public"]['Enums']["order_status"],"subtotal_cents": number,"total_cents": number,"updated_at"?: string,"user_agent"?: string | null
                  }
                  Update: {
                    "buyer_email"?: string,"buyer_name"?: string | null,"buyer_phone"?: string | null,"cancelled_at"?: string | null,"created_at"?: string,"currency"?: string,"discount_code_cents"?: number,"discount_code_id"?: string | null,"event_id"?: string,"failed_at"?: string | null,"id"?: string,"idempotency_key"?: string | null,"ip_address"?: unknown,"notes"?: string | null,"paid_at"?: string | null,"quantity_discount_cents"?: number,"reference"?: string,"reservation_expires_at"?: string | null,"source"?: string,"status"?: Database["public"]['Enums']["order_status"],"subtotal_cents"?: number,"total_cents"?: number,"updated_at"?: string,"user_agent"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "orders_discount_code_id_fkey"
      columns: ["discount_code_id"]
isOneToOne: false
      referencedRelation: "discount_codes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "orders_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    }
                  ]
                },"participants": {
                  Row: {
                    "city": string,"created_at": string,"email": string,"event_id": string,"extra_fields": NonNullable<Json>,"first_name": string,"id": string,"instagram": string | null,"last_name": string,"national_id": string,"order_id": string,"order_item_id": string | null,"phone": string,"updated_at": string
                  }
                  Insert: {
                    "city": string,"created_at"?: string,"email": string,"event_id": string,"extra_fields"?: NonNullable<Json>,"first_name": string,"id"?: string,"instagram"?: string | null,"last_name": string,"national_id": string,"order_id": string,"order_item_id"?: string | null,"phone": string,"updated_at"?: string
                  }
                  Update: {
                    "city"?: string,"created_at"?: string,"email"?: string,"event_id"?: string,"extra_fields"?: NonNullable<Json>,"first_name"?: string,"id"?: string,"instagram"?: string | null,"last_name"?: string,"national_id"?: string,"order_id"?: string,"order_item_id"?: string | null,"phone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "participants_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "participants_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "participants_order_item_id_fkey"
      columns: ["order_item_id"]
isOneToOne: false
      referencedRelation: "order_items"
      referencedColumns: ["id"]
    }
                  ]
                },"payment_events": {
                  Row: {
                    "checksum_valid": boolean,"created_at": string,"dedupe_key": string,"error_code": string | null,"http_status": number | null,"id": string,"payment_id": string | null,"processed_at": string | null,"received_at": string,"result": Database["public"]['Enums']["payment_event_result"] | null,"wompi_event_name": string,"wompi_transaction_id": string | null
                  }
                  Insert: {
                    "checksum_valid": boolean,"created_at"?: string,"dedupe_key": string,"error_code"?: string | null,"http_status"?: number | null,"id"?: string,"payment_id"?: string | null,"processed_at"?: string | null,"received_at"?: string,"result"?: Database["public"]['Enums']["payment_event_result"] | null,"wompi_event_name": string,"wompi_transaction_id"?: string | null
                  }
                  Update: {
                    "checksum_valid"?: boolean,"created_at"?: string,"dedupe_key"?: string,"error_code"?: string | null,"http_status"?: number | null,"id"?: string,"payment_id"?: string | null,"processed_at"?: string | null,"received_at"?: string,"result"?: Database["public"]['Enums']["payment_event_result"] | null,"wompi_event_name"?: string,"wompi_transaction_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_events_payment_id_fkey"
      columns: ["payment_id"]
isOneToOne: false
      referencedRelation: "payments"
      referencedColumns: ["id"]
    }
                  ]
                },"payments": {
                  Row: {
                    "amount_cents": number,"approved_at": string | null,"attempt": number,"created_at": string,"currency": string,"finalized_at": string | null,"id": string,"integrity_signature": string | null,"last_reconciled_at": string | null,"last_reconciliation_failure": string | null,"last_reconciliation_result": string | null,"next_reconciliation_at": string | null,"order_id": string,"payment_method_type": string | null,"provider_payload": Json | null,"raw_wompi_status": string | null,"reconciliation_attempts": number,"status": Database["public"]['Enums']["payment_status"],"status_message": string | null,"updated_at": string,"wompi_reference": string,"wompi_transaction_id": string | null
                  }
                  Insert: {
                    "amount_cents": number,"approved_at"?: string | null,"attempt": number,"created_at"?: string,"currency"?: string,"finalized_at"?: string | null,"id"?: string,"integrity_signature"?: string | null,"last_reconciled_at"?: string | null,"last_reconciliation_failure"?: string | null,"last_reconciliation_result"?: string | null,"next_reconciliation_at"?: string | null,"order_id": string,"payment_method_type"?: string | null,"provider_payload"?: Json | null,"raw_wompi_status"?: string | null,"reconciliation_attempts"?: number,"status"?: Database["public"]['Enums']["payment_status"],"status_message"?: string | null,"updated_at"?: string,"wompi_reference": string,"wompi_transaction_id"?: string | null
                  }
                  Update: {
                    "amount_cents"?: number,"approved_at"?: string | null,"attempt"?: number,"created_at"?: string,"currency"?: string,"finalized_at"?: string | null,"id"?: string,"integrity_signature"?: string | null,"last_reconciled_at"?: string | null,"last_reconciliation_failure"?: string | null,"last_reconciliation_result"?: string | null,"next_reconciliation_at"?: string | null,"order_id"?: string,"payment_method_type"?: string | null,"provider_payload"?: Json | null,"raw_wompi_status"?: string | null,"reconciliation_attempts"?: number,"status"?: Database["public"]['Enums']["payment_status"],"status_message"?: string | null,"updated_at"?: string,"wompi_reference"?: string,"wompi_transaction_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payments_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"pricing_policy": {
                  Row: {
                    "discount_combination": string,"id": boolean,"updated_at": string
                  }
                  Insert: {
                    "discount_combination"?: string,"id"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "discount_combination"?: string,"id"?: boolean,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"pricing_tiers": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"name": string,"price_cents": number,"quantity_limit": number | null,"quantity_reserved": number,"quantity_sold": number,"sales_ends_at": string | null,"sales_starts_at": string | null,"sequence": number,"ticket_type_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"price_cents": number,"quantity_limit"?: number | null,"quantity_reserved"?: number,"quantity_sold"?: number,"sales_ends_at"?: string | null,"sales_starts_at"?: string | null,"sequence": number,"ticket_type_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"price_cents"?: number,"quantity_limit"?: number | null,"quantity_reserved"?: number,"quantity_sold"?: number,"sales_ends_at"?: string | null,"sales_starts_at"?: string | null,"sequence"?: number,"ticket_type_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pricing_tiers_ticket_type_id_fkey"
      columns: ["ticket_type_id"]
isOneToOne: false
      referencedRelation: "ticket_types"
      referencedColumns: ["id"]
    }
                  ]
                },"quantity_discounts": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"min_quantity": number,"percent_bps": number,"ticket_type_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"min_quantity": number,"percent_bps": number,"ticket_type_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"min_quantity"?: number,"percent_bps"?: number,"ticket_type_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quantity_discounts_ticket_type_id_fkey"
      columns: ["ticket_type_id"]
isOneToOne: false
      referencedRelation: "ticket_types"
      referencedColumns: ["id"]
    }
                  ]
                },"rate_limit_counters": {
                  Row: {
                    "counter": number,"key_hash": string,"scope": string,"window_start": string
                  }
                  Insert: {
                    "counter"?: number,"key_hash": string,"scope": string,"window_start": string
                  }
                  Update: {
                    "counter"?: number,"key_hash"?: string,"scope"?: string,"window_start"?: string
                  }
                  Relationships: [
                    
                  ]
                },"sheets_projections": {
                  Row: {
                    "attempt_count": number,"created_at": string,"event_id": string,"last_error": string | null,"last_synced_at": string | null,"next_attempt_at": string | null,"status": Database["public"]['Enums']["sheets_projection_status"],"ticket_id": string,"updated_at": string
                  }
                  Insert: {
                    "attempt_count"?: number,"created_at"?: string,"event_id": string,"last_error"?: string | null,"last_synced_at"?: string | null,"next_attempt_at"?: string | null,"status"?: Database["public"]['Enums']["sheets_projection_status"],"ticket_id": string,"updated_at"?: string
                  }
                  Update: {
                    "attempt_count"?: number,"created_at"?: string,"event_id"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"next_attempt_at"?: string | null,"status"?: Database["public"]['Enums']["sheets_projection_status"],"ticket_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sheets_projections_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sheets_projections_ticket_id_fkey"
      columns: ["ticket_id"]
isOneToOne: true
      referencedRelation: "tickets"
      referencedColumns: ["id"]
    }
                  ]
                },"sheets_participant_projections": {
                  Row: {
                    "attempt_count": number,"created_at": string,"event_id": string,"last_error": string | null,"last_synced_at": string | null,"next_attempt_at": string | null,"participant_id": string,"status": Database["public"]['Enums']["sheets_projection_status"],"updated_at": string
                  }
                  Insert: {
                    "attempt_count"?: number,"created_at"?: string,"event_id": string,"last_error"?: string | null,"last_synced_at"?: string | null,"next_attempt_at"?: string | null,"participant_id": string,"status"?: Database["public"]['Enums']["sheets_projection_status"],"updated_at"?: string
                  }
                  Update: {
                    "attempt_count"?: number,"created_at"?: string,"event_id"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"next_attempt_at"?: string | null,"participant_id"?: string,"status"?: Database["public"]['Enums']["sheets_projection_status"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sheets_participant_projections_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sheets_participant_projections_participant_id_fkey"
      columns: ["participant_id"]
isOneToOne: true
      referencedRelation: "participants"
      referencedColumns: ["id"]
    }
                  ]
                },"ticket_types": {
                  Row: {
                    "code": string,"created_at": string,"description": string | null,"event_id": string,"id": string,"is_active": boolean,"max_per_order": number | null,"min_per_order": number,"name": string,"updated_at": string
                  }
                  Insert: {
                    "code": string,"created_at"?: string,"description"?: string | null,"event_id": string,"id"?: string,"is_active"?: boolean,"max_per_order"?: number | null,"min_per_order"?: number,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"description"?: string | null,"event_id"?: string,"id"?: string,"is_active"?: boolean,"max_per_order"?: number | null,"min_per_order"?: number,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ticket_types_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    }
                  ]
                },"ticket_bundles": {
                  Row: {
                    "code": string,"created_at": string,"event_id": string,"id": string,"included_admissions": number,"is_active": boolean,"name": string,"price_cents": number,"pricing_tier_id": string,"ticket_type_id": string,"updated_at": string
                  }
                  Insert: {
                    "code": string,"created_at"?: string,"event_id": string,"id"?: string,"included_admissions": number,"is_active"?: boolean,"name": string,"price_cents": number,"pricing_tier_id": string,"ticket_type_id": string,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"event_id"?: string,"id"?: string,"included_admissions"?: number,"is_active"?: boolean,"name"?: string,"price_cents"?: number,"pricing_tier_id"?: string,"ticket_type_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ticket_bundles_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ticket_bundles_stage_ticket_type_fk"
      columns: ["pricing_tier_id","ticket_type_id"]
isOneToOne: false
      referencedRelation: "pricing_tiers"
      referencedColumns: ["id","ticket_type_id"]
    },{
      foreignKeyName: "ticket_bundles_ticket_type_id_fkey"
      columns: ["ticket_type_id"]
isOneToOne: false
      referencedRelation: "ticket_types"
      referencedColumns: ["id"]
    }
                  ]
                },"tickets": {
                  Row: {
                    "cancelled_at": string | null,"created_at": string,"event_id": string,"id": string,"issued_at": string,"order_id": string,"order_item_id": string,"order_item_seq": number,"participant_id": string | null,"price_paid_cents": number,"status": Database["public"]['Enums']["ticket_status"],"ticket_type_id": string,"token": string,"updated_at": string
                  }
                  Insert: {
                    "cancelled_at"?: string | null,"created_at"?: string,"event_id": string,"id"?: string,"issued_at"?: string,"order_id": string,"order_item_id": string,"order_item_seq"?: number,"participant_id"?: string | null,"price_paid_cents": number,"status"?: Database["public"]['Enums']["ticket_status"],"ticket_type_id": string,"token": string,"updated_at"?: string
                  }
                  Update: {
                    "cancelled_at"?: string | null,"created_at"?: string,"event_id"?: string,"id"?: string,"issued_at"?: string,"order_id"?: string,"order_item_id"?: string,"order_item_seq"?: number,"participant_id"?: string | null,"price_paid_cents"?: number,"status"?: Database["public"]['Enums']["ticket_status"],"ticket_type_id"?: string,"token"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tickets_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tickets_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tickets_order_item_id_fkey"
      columns: ["order_item_id"]
isOneToOne: false
      referencedRelation: "order_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tickets_participant_id_fkey"
      columns: ["participant_id"]
isOneToOne: true
      referencedRelation: "participants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tickets_ticket_type_id_fkey"
      columns: ["ticket_type_id"]
isOneToOne: false
      referencedRelation: "ticket_types"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "operational_export": {
                  Row: {
                    "Apellido": string | null,"Autorización de datos": boolean | null,"Autorización de datos fecha": string | null,"Autorización de datos versión": string | null,"Autorización próximos eventos": boolean | null,"Cédula": string | null,"Ciudad": string | null,"Código de entrada": string | null,"Correo": string | null,"Creada": string | null,"Estado de la entrada": Database["public"]['Enums']["ticket_status"] | null,"Estado de la orden": Database["public"]['Enums']["order_status"] | null,"Estado del pago": Database["public"]['Enums']["payment_status"] | null,"Estado Wompi": string | null,"Etapa de venta": string | null,"Evento": string | null,"Fecha de ingreso": string | null,"Ingreso": boolean | null,"Instagram": string | null,"Moneda": string | null,"Nombre": string | null,"Precio centavos": number | null,"Referencia de la orden": string | null,"Teléfono": string | null,"Tipo de entrada": string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "attach_participant":
{ Args: { "p_buyer_email": string,"p_now"?: string,"p_order_reference": string,"p_participant": Json,"p_policy_version"?: string }; Returns: Json
                           },
"claim_email_deliveries":
{ Args: { "p_limit"?: number,"p_max_attempts"?: number,"p_now"?: string,"p_stale_after_seconds"?: number }; Returns: {
              "attempt_count": number,
"created_at": string,
"id": string,
"idempotency_key": string,
"last_error": string | null,
"next_attempt_at": string | null,
"provider": string,
"provider_message_id": string | null,
"queued_at": string,
"recipient_email": string,
"sent_at": string | null,
"status": Database["public"]['Enums']["email_delivery_status"],
"template": string,
"ticket_id": string,
"updated_at": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "email_deliveries"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_payment_reconciliations":
{ Args: { "p_limit"?: number,"p_max_attempts"?: number,"p_now"?: string }; Returns: Json[]
                           },
"claim_sheet_projections":
{ Args: { "p_limit"?: number,"p_max_attempts"?: number,"p_now"?: string,"p_stale_after_seconds"?: number }; Returns: {
              "attempt_count": number,
"created_at": string,
"event_id": string,
"last_error": string | null,
"last_synced_at": string | null,
"next_attempt_at": string | null,
"status": Database["public"]['Enums']["sheets_projection_status"],
"ticket_id": string,
"updated_at": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "sheets_projections"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_webhook_event":
{ Args: { "p_checksum_valid"?: boolean,"p_dedupe_key": string,"p_event_name": string,"p_wompi_transaction_id"?: string }; Returns: Json
                           },
"cleanup_rate_limit_counters":
{ Args: { "p_now"?: string,"p_older_than_seconds"?: number }; Returns: Json
                           },
"confirm_payment":
{ Args: { "p_amount_cents": number,"p_currency": string,"p_order_reference": string,"p_payment_method_type"?: string,"p_provider_payload"?: Json,"p_status_message"?: string,"p_wompi_reference": string,"p_wompi_status": string,"p_wompi_transaction_id": string }; Returns: Json
                           },
"consume_rate_limit":
{ Args: { "p_key": string,"p_limit": number,"p_now"?: string,"p_scope": string,"p_window_seconds": number }; Returns: Json
                           },
"create_order":
{ Args: { "p_buyer_email": string,"p_buyer_name": string,"p_buyer_phone": string,"p_discount_code"?: string,"p_event_code": string,"p_idempotency_key"?: string,"p_ip_address"?: string,"p_participant": Json,"p_quantity": number,"p_reservation_minutes": number,"p_ticket_type_code": string,"p_user_agent"?: string }; Returns: Json
                           },
"create_bundle_order":
{ Args: { "p_buyer_email": string,"p_buyer_name": string,"p_buyer_phone": string,"p_bundle_code": string,"p_discount_code"?: string,"p_event_code": string,"p_idempotency_key"?: string,"p_ip_address"?: string,"p_participant": Json,"p_quantity": number,"p_reservation_minutes": number,"p_ticket_type_code": string,"p_user_agent"?: string }; Returns: Json
                           },
"expire_pending_orders":
{ Args: { "p_limit"?: number,"p_now"?: string }; Returns: Json
                           },
"finalize_webhook_event":
{ Args: { "p_error_code"?: string,"p_event_id": string,"p_http_status": number,"p_payment_id"?: string,"p_result": Database["public"]['Enums']["payment_event_result"],"p_wompi_transaction_id"?: string }; Returns: Json
                           },
"finish_email_delivery":
{ Args: { "p_delivery_id": string,"p_error"?: string,"p_next_attempt_at"?: string,"p_now"?: string,"p_provider_message_id"?: string,"p_status": Database["public"]['Enums']["email_delivery_status"] }; Returns: Json
                           },
"finish_payment_reconciliation":
{ Args: { "p_failure"?: string,"p_next_attempt_at"?: string,"p_now"?: string,"p_payment_id": string,"p_result": string }; Returns: Json
                           },
"claim_alert_notifications":
{ Args: { "p_limit"?: number,"p_max_attempts"?: number,"p_now"?: string }; Returns: Json[]
                           },
"finish_alert_notifications":
{ Args: { "p_alert_ids": string[],"p_now"?: string }; Returns: number
                           },
"raise_unresolved_payment_alerts":
{ Args: { "p_max_attempts"?: number,"p_now"?: string }; Returns: number
                           },
"record_operational_alert":
{ Args: { "p_dedupe_key": string,"p_detail"?: string,"p_kind": string,"p_now"?: string,"p_order_reference"?: string,"p_payment_id"?: string,"p_provider"?: string,"p_severity": string }; Returns: Json
                           },
"finish_sheet_projections":
{ Args: { "p_error"?: string,"p_next_attempt_at"?: string,"p_now"?: string,"p_status": Database["public"]['Enums']["sheets_projection_status"],"p_ticket_ids": (string)[] }; Returns: Json
                           },
"get_operator_ticket":
{ Args: { "p_ticket_token": string }; Returns: Json
                           },
"get_order_status":
{ Args: { "p_buyer_email": string,"p_order_reference": string }; Returns: Json
                           },
"get_public_availability":
{ Args: { "p_code": string }; Returns: Json
                           },
"get_public_event":
{ Args: { "p_code": string }; Returns: Json
                           },
"get_public_ticket":
{ Args: { "p_ticket_token": string }; Returns: Json
                           },
"queue_ticket_emails":
{ Args: { "p_order_id": string,"p_template"?: string }; Returns: Json
                           },
"quote_order_price":
{ Args: { "p_discount_code"?: string,"p_event_code": string,"p_quantity": number,"p_reservation_minutes": number,"p_ticket_type_code": string }; Returns: Json
                           },
"quote_bundle_order_price":
{ Args: { "p_bundle_code": string,"p_discount_code"?: string,"p_event_code": string,"p_quantity": number,"p_reservation_minutes": number,"p_ticket_type_code": string }; Returns: Json
                           },
"record_check_in":
{ Args: { "p_method"?: string,"p_notes"?: string,"p_now"?: string,"p_operator_label": string,"p_operator_user_id"?: string,"p_ticket_token": string }; Returns: Json
                           },
"record_webhook_rejection":
{ Args: { "p_dedupe_key": string,"p_error_code": string,"p_event_name": string,"p_http_status": number }; Returns: Json
                           },
"resolve_payment_for_buyer":
{ Args: { "p_buyer_email": string,"p_order_reference": string }; Returns: Json
                           },
"retry_payment":
{ Args: { "p_buyer_email": string,"p_now"?: string,"p_order_reference": string,"p_reservation_minutes": number }; Returns: Json
                           },
"sheet_projection_stats":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"claim_participant_sheet_projections":
{ Args: { "p_limit"?: number,"p_max_attempts"?: number,"p_now"?: string,"p_stale_after_seconds"?: number }; Returns: {
              "attempt_count": number,
"created_at": string,
"event_id": string,
"last_error": string | null,
"last_synced_at": string | null,
"next_attempt_at": string | null,
"participant_id": string,
"status": Database["public"]['Enums']["sheets_projection_status"],
"updated_at": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "sheets_participant_projections"
        isOneToOne: false
        isSetofReturn: true
      } },
"finish_participant_sheet_projections":
{ Args: { "p_error"?: string,"p_next_attempt_at"?: string,"p_now"?: string,"p_participant_ids": (string)[],"p_status": Database["public"]['Enums']["sheets_projection_status"] }; Returns: Json
                           },
"participant_sheet_projection_stats":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"update_participant":
{ Args: { "p_buyer_email": string,"p_now"?: string,"p_order_reference": string,"p_participant": Json,"p_participant_id": string,"p_policy_version"?: string }; Returns: Json
                           }
          }
          Enums: {
            "consent_kind": "DATA_PROCESSING"|"FUTURE_EVENTS","discount_kind": "PERCENT"|"FIXED","email_delivery_status": "QUEUED"|"SENDING"|"SENT"|"FAILED"|"CANCELLED","event_status": "DRAFT"|"PUBLISHED"|"CLOSED","order_status": "PENDING"|"PAID"|"FAILED"|"CANCELLED"|"EXPIRED","payment_event_result": "APPLIED"|"DUPLICATE"|"REJECTED"|"IGNORED","payment_status": "pending"|"approved"|"declined"|"voided"|"error"|"unknown"|"refunded","sheets_projection_status": "QUEUED"|"SYNCING"|"SYNCED"|"FAILED","ticket_status": "ACTIVE"|"CANCELLED"|"REFUNDED"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "consent_kind": ["DATA_PROCESSING", "FUTURE_EVENTS"],"discount_kind": ["PERCENT", "FIXED"],"email_delivery_status": ["QUEUED", "SENDING", "SENT", "FAILED", "CANCELLED"],"event_status": ["DRAFT", "PUBLISHED", "CLOSED"],"order_status": ["PENDING", "PAID", "FAILED", "CANCELLED", "EXPIRED"],"payment_event_result": ["APPLIED", "DUPLICATE", "REJECTED", "IGNORED"],"payment_status": ["pending", "approved", "declined", "voided", "error", "unknown", "refunded"],"sheets_projection_status": ["QUEUED", "SYNCING", "SYNCED", "FAILED"],"ticket_status": ["ACTIVE", "CANCELLED", "REFUNDED"]
          }
        }
} as const
