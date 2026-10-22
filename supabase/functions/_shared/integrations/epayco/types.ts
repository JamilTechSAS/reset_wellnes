/**
 * ePayco integration types (Colombia).
 *
 * Types matching ePayco Standard Checkout, Confirmation Webhooks, and
 * Transaction Query / Validation endpoints (docs.epayco.co).
 */

export const EPAYCO_SUPPORTED_CURRENCY = "COP";

/**
 * ePayco response codes (x_cod_response / x_cod_transaction_state).
 * 1 = Aceptada / Aprobada
 * 2 = Rechazada
 * 3 = Pendiente
 * 4 = Fallida / Error
 */
export const EPAYCO_RESPONSE_CODES = {
  APPROVED: 1,
  REJECTED: 2,
  PENDING: 3,
  FAILED: 4,
} as const;

export type EpaycoResponseCode = (typeof EPAYCO_RESPONSE_CODES)[keyof typeof EPAYCO_RESPONSE_CODES];

export type EpaycoWebhookPayload = {
  readonly x_cust_id_cliente?: string | number | undefined;
  readonly p_cust_id_cliente?: string | number | undefined;
  readonly x_ref_payco: string;
  readonly x_id_invoice?: string | undefined;
  readonly x_id_factura?: string | undefined;
  readonly x_description?: string | undefined;
  readonly x_amount: string | number;
  readonly x_amount_ok?: string | number | undefined;
  readonly x_tax?: string | number | undefined;
  readonly x_amount_base?: string | number | undefined;
  readonly x_currency_code: string;
  readonly x_bank_name?: string | undefined;
  readonly x_cardnumber?: string | undefined;
  readonly x_quotas?: string | number | undefined;
  readonly x_response?: string | undefined;
  readonly x_respuesta?: string | undefined;
  readonly x_approval_code?: string | undefined;
  readonly x_transaction_id: string;
  readonly x_fecha_transaccion?: string | undefined;
  readonly x_transaction_date?: string | undefined;
  readonly x_cod_response: string | number;
  readonly x_cod_respuesta?: string | number | undefined;
  readonly x_cod_transaction_state?: string | number | undefined;
  readonly x_response_reason_text?: string | undefined;
  readonly x_errorcode?: string | undefined;
  readonly x_franchise?: string | undefined;
  readonly x_business?: string | undefined;
  readonly x_customer_email?: string | undefined;
  readonly x_customer_name?: string | undefined;
  readonly x_customer_lastname?: string | undefined;
  readonly x_customer_phone?: string | undefined;
  readonly x_customer_movil?: string | undefined;
  readonly x_signature: string;
  readonly x_test_request?: string | boolean | undefined;
  readonly [key: string]: unknown;
};

export type EpaycoTransactionData = {
  readonly id: string;
  readonly refPayco: string;
  readonly reference: string;
  readonly invoice: string;
  readonly transactionId: string;
  readonly status: "approved" | "declined" | "pending" | "error" | "unknown";
  readonly rawStatus: string;
  readonly amount: number;
  readonly amountInCents: number;
  readonly currency: string;
  readonly responseCode: number;
  readonly responseText: string;
  readonly statusMessage: string | null;
  readonly paymentMethodType: string | null;
  readonly signature: string;
  readonly isTest: boolean;
  readonly franchise: string | null;
  readonly bankName: string | null;
  readonly transactionDate: string | null;
  readonly rawPayload: Record<string, unknown>;
  readonly rawResponse?: unknown;
};

export type EpaycoTransactionApiResponse = {
  readonly success: boolean;
  readonly title?: string | undefined;
  readonly message?: string | undefined;
  readonly data?: EpaycoWebhookPayload | Record<string, unknown> | undefined;
};

export type EpaycoCheckout = {
  readonly provider: "epayco";
  readonly sessionId?: string | undefined;
  readonly publicKey: string;
  readonly test: boolean;
  readonly reference: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly redirectUrl: string | null;
  readonly confirmationUrl: string | null;
  readonly customerData: {
    readonly email: string | null;
    readonly fullName: string | null;
    readonly phoneNumber: string | null;
    readonly phoneNumberPrefix: string | null;
  };
};
