import { VerifactuResponseError } from '~/errors'
import { HttpsTransport, type VerifactuTransport } from '~/transport'
import { buildValidationUrl, type QrContent, type ValidationUrlOptions } from '~/qr'

/**
 * AEAT's public invoice validation service (the one a QR code points to), asked for its machine-readable answer
 * (`formato=json`). Useful to check that an invoice you issued is found, or that one you received is genuine. It needs no
 * certificate. Per AEAT's QR document it is limited per day, so do not poll it.
 */

/** What AEAT says of an invoice */
export type InvoiceVerificationOutcome =
  /** `00`: the invoice is registered at AEAT */
  | 'found'
  /** `01`: no such invoice is registered, or it is cancelled */
  | 'not-found'
  /** `02`: the invoice comes from a system that does not issue verifiable invoices, so it cannot be checked */
  | 'not-verifiable'
  /** AEAT could not process the request (`KO`): see `message` and `errorCodes` */
  | 'error'

export interface InvoiceVerification {
  outcome: InvoiceVerificationOutcome
  /** AEAT's `mensaje` */
  message: string
  /** AEAT's `status`: `OK` or `KO` */
  status: 'OK' | 'KO'
  /** AEAT's result code (`00`, `01`, `02`) when it gave one */
  resultCode?: string
  /** The error codes of a `KO` answer (`codigo_error`, joined by "." when there are several): 1001 to 1004 for missing parameters, 2001 to 2006 for malformed ones, 3001 for a technical error, 3002 when the day's limit was exceeded */
  errorCodes: string[]
  /** What AEAT echoed back about the invoice */
  invoice?: { nif: string, number: string, issueDate: string, amount: string }
}

export interface VerifyInvoiceOptions extends Omit<ValidationUrlOptions, 'json'> {
  /** Your own HTTP stack or a fake; by default plain HTTPS without a certificate */
  transport?: VerifactuTransport
  timeoutMs?: number
}

interface RawAnswer {
  status?: string
  mensaje?: string
  codigo_error?: string
  respuesta?: { resultado?: string, nif?: string, numserie?: string, fecha?: string, importe?: string }
}

const publicTransport = new HttpsTransport()

/** Asks AEAT's validation service about an invoice */
export async function verifyInvoice(content: QrContent, options: VerifyInvoiceOptions): Promise<InvoiceVerification> {
  const transport = options.transport ?? publicTransport
  const response = await transport.send({
    url: buildValidationUrl(content, { ...options, json: true }),
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs: options.timeoutMs ?? 30_000
  })

  let answer: RawAnswer
  try {
    answer = JSON.parse(response.body) as RawAnswer
  }
  catch {
    throw new VerifactuResponseError(`The validation service did not answer with JSON (HTTP ${response.status})`, response.status, response.body.slice(0, 2000))
  }

  const status = answer.status === 'OK' ? 'OK' : 'KO'
  const result = answer.respuesta?.resultado
  const outcome: InvoiceVerificationOutcome = status === 'KO' ? 'error' : result === '00' ? 'found' : result === '02' ? 'not-verifiable' : 'not-found'
  const echoed = answer.respuesta
  return {
    outcome,
    message: answer.mensaje ?? '',
    status,
    ...(result ? { resultCode: result } : {}),
    errorCodes: answer.codigo_error ? answer.codigo_error.split('.').filter(Boolean) : [],
    ...(echoed?.nif ? { invoice: { nif: echoed.nif, number: echoed.numserie ?? '', issueDate: echoed.fecha ?? '', amount: echoed.importe ?? '' } } : {})
  }
}
