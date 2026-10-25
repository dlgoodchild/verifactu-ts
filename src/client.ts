import { serviceUrl, type CertificateKind, type ServiceMode, type VerifactuEnvironment } from '~/environment'
import { VerifactuBatchError, VerifactuConfigurationError, VerifactuResponseError } from '~/errors'
import { FlowControl, MaxRecordsPerBatch, toBatches } from '~/flow-control'
import { HttpsTransport, type ClientCertificate, type HttpResponse, type VerifactuTransport } from '~/transport'
import { assertNoErrors, validateSubmission } from '~/validate'
import { buildQueryXml, buildSubmissionXml, parseQueryReply, parseSoapFault, parseSubmissionReply } from '~/xml'
import type { BillingRecord, QueryReply, RecordQuery, SubmissionHeader, SubmissionReply, ValidationIssue } from '~/types'

export interface VerifactuClientOptions {
  environment: VerifactuEnvironment
  /** Which AEAT address the certificate is served on: `personal` (default) or company `seal` */
  certificateKind?: CertificateKind
  /**
   * Which of AEAT's two web service addresses to use. `verifactu` (default, the normal case): the VERI*FACTU address,
   * where every record is sent as it is created, with the query service. `requirement`: the address a system that does
   * not send routinely uses to send records AEAT asked for; it has no query (see the README, "The two ways to comply").
   */
  mode?: ServiceMode
  /** The certificate to authenticate with. Not needed if you supply your own `transport`. */
  certificate?: ClientCertificate
  /** Your own HTTP stack, or a fake in tests. Without one, `HttpsTransport` is used with `certificate`. */
  transport?: VerifactuTransport
  /** Replaces the address the service is looked up at (for a proxy or a stub); the default comes from AEAT's service definition */
  endpoint?: string
  /** How long to wait for an answer, in milliseconds (default 60000) */
  timeoutMs?: number
  /** Set false to send without checking the records locally first (default true: errors stop the submission) */
  validate?: boolean
}

export interface BatchOptions {
  /** Keeps the wait AEAT asks for between submissions across calls; created fresh if left out */
  flow?: FlowControl
  /** How to wait; defaults to `setTimeout`. Pass a fake in tests. */
  sleep?: (ms: number) => Promise<void>
  /** The clock; defaults to `new Date()` */
  now?: () => Date
  /** Called after each batch is answered, e.g. to save the outcome before the next goes out */
  onBatch?: (reply: SubmissionReply, records: BillingRecord[], index: number) => void | Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A client of AEAT's VERI*FACTU web service. It builds and validates the SOAP messages, sends them, and reads the
 * answers into typed results. It keeps no state and touches no database: the caller owns the records, their chain and
 * what to do with the outcome. Every error is a `VerifactuError` subclass:
 *
 * - `VerifactuValidationError`: a record is wrong; nothing was sent.
 * - `VerifactuTransportError`, `VerifactuResponseError`, and `VerifactuSoapFaultError` with `retryable`: the outcome
 *   is unknown or AEAT had a problem: send the same message again (AEAT's guidance), after a wait.
 * - `VerifactuSoapFaultError` with `retryable = false`: the message is wrong (see `faultString`): fix it first.
 */
export class VerifactuClient {
  readonly url: string
  private readonly transport: VerifactuTransport
  private readonly timeoutMs: number
  private readonly validate: boolean
  private readonly mode: ServiceMode

  constructor(options: VerifactuClientOptions) {
    this.mode = options.mode ?? 'verifactu'
    this.url = options.endpoint ?? serviceUrl(options.environment, options.certificateKind ?? 'personal', this.mode)
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.validate = options.validate !== false

    if (options.transport) {
      this.transport = options.transport
    }
    else if (options.certificate) {
      this.transport = new HttpsTransport({ certificate: options.certificate })
    }
    else {
      throw new VerifactuConfigurationError('Give a client certificate or a transport: AEAT only accepts submissions authenticated with a certificate')
    }
  }

  /** Checks a submission without sending it: every issue found, errors and warnings */
  check(header: SubmissionHeader, records: BillingRecord[]): ValidationIssue[] {
    const issues = validateSubmission(header, records)
    if (this.mode === 'requirement') {
      // A system that does not send records routinely must sign every one (see `signRecord`)
      records.forEach((record, index) => {
        if (!record.signature) issues.push({ severity: 'warning', code: 'signature-expected', path: `records[${index}].signature`, message: 'records sent in answer to a requirement must be signed (see signRecord)' })
      })
    }
    return issues
  }

  /** The SOAP message a submission would send (for logging, storing as proof, or tests) */
  buildSubmission(header: SubmissionHeader, records: BillingRecord[]): string {
    return buildSubmissionXml(header, records)
  }

  private async post(body: string): Promise<HttpResponse> {
    return await this.transport.send({
      url: this.url,
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'Accept': 'text/xml', 'SOAPAction': '""' },
      body,
      timeoutMs: this.timeoutMs
    })
  }

  /**
   * Submits up to 1000 records in one message. Validates them first (unless turned off): a record with an error
   * throws `VerifactuValidationError`. The caller must wait `waitSeconds` of the previous reply before calling again
   * (`submitInBatches` and `FlowControl` do this).
   */
  async submit(header: SubmissionHeader, records: BillingRecord[]): Promise<SubmissionReply> {
    if (this.validate) {
      assertNoErrors(this.check(header, records))
    }
    const response = await this.post(buildSubmissionXml(header, records))
    return this.read(response, parseSubmissionReply)
  }

  /**
   * Submits any number of records in order, in batches of at most 1000, honouring AEAT's flow control (it waits as
   * AEAT asked between batches, unless a full batch is waiting). Stops at the first failure with a
   * `VerifactuBatchError` that holds the replies of the batches that were answered, so the caller can save those and
   * carry on from the next batch later.
   */
  async submitInBatches(header: SubmissionHeader, records: BillingRecord[], options: BatchOptions = {}): Promise<SubmissionReply[]> {
    const flow = options.flow ?? new FlowControl()
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? (() => new Date())
    const batches = toBatches(records, MaxRecordsPerBatch)
    const replies: SubmissionReply[] = []

    let remaining = records.length
    for (let index = 0; index < batches.length; index++) {
      const delay = flow.delayMs(remaining, now())
      if (delay > 0) await sleep(delay)

      try {
        const reply = await this.submit(header, batches[index])
        flow.recordSubmission(now(), reply.waitSeconds)
        replies.push(reply)
        await options.onBatch?.(reply, batches[index], index)
      }
      catch (error) {
        throw new VerifactuBatchError(
          `Batch ${index + 1} of ${batches.length} failed after ${replies.length} were answered: ${(error as Error).message}`,
          replies,
          error
        )
      }
      remaining -= batches[index].length
    }
    return replies
  }

  /** Asks AEAT for records already submitted (VERI*FACTU mode only). One page: see `queryPages` for all. */
  async query(query: RecordQuery): Promise<QueryReply> {
    if (this.mode !== 'verifactu') {
      throw new VerifactuConfigurationError('Queries are only available from the VERI*FACTU (voluntary remission) service')
    }
    const response = await this.post(buildQueryXml(query))
    return this.read(response, parseQueryReply)
  }

  /** Every page of a query, one at a time as AEAT's pagination key allows (a page holds up to 10000 records) */
  async* queryPages(query: RecordQuery): AsyncGenerator<QueryReply> {
    let next: RecordQuery = query
    for (;;) {
      const page = await this.query(next)
      yield page
      if (!page.hasMore || !page.nextPageKey) return
      next = { ...query, pageKey: page.nextPageKey }
    }
  }

  /** All the records a query matches, over as many pages as it takes */
  async queryAll(query: RecordQuery): Promise<QueryReply['records']> {
    const records: QueryReply['records'] = []
    for await (const page of this.queryPages(query)) {
      records.push(...page.records)
    }
    return records
  }

  private read<T>(response: HttpResponse, parse: (xml: string, status?: number) => T): T {
    // A fault comes with HTTP 500, but is read before the status is judged
    const fault = parseSoapFault(response.body, response.status)
    if (fault) throw fault
    if (response.status < 200 || response.status >= 300) {
      throw new VerifactuResponseError(`AEAT answered HTTP ${response.status}`, response.status, response.body.slice(0, 2000))
    }
    return parse(response.body, response.status)
  }
}
