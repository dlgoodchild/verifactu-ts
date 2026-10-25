import {
  AnomalyTypes, CancellationGenerators, CorrectiveInvoiceTypes, EventTypes, Exemptions, HashTypes, InvoiceTypes, IssuedByOthers, OperationQualifications, OtherIdTypes,
  PreviousRejections, RectificationTypes, RegimeKeys, Taxes, TaxedQualifications
} from '~/codes'
import { EventDataKinds, type AnomalyChecks, type EventChaining, type EventData, type EventLink, type EventRecord } from '~/events'
import { isCountryCode } from '~/country-codes'
import { VerifactuValidationError } from '~/errors'
import { isAmount, isIsoDate, isPrintableAscii, isRate, sumAmounts, toCents } from '~/format'
import { verifyEventHash, verifyRecordHash } from '~/hash'
import type {
  BillingRecord, CancellationRecord, Chaining, InvoiceRecord, NormalisedBreakdownLine, OtherId, Party, SoftwareSystem, SubmissionHeader, Taxpayer, ValidationIssue
} from '~/types'

/**
 * Local checks of records before they are sent, so a mistake is found at once and not through a rejection.
 *
 * - An `error` is something AEAT's published schema (XSD) rejects: the record would not be accepted.
 * - A `warning` is a business rule the schema cannot express, taken from AEAT's documentation, that AEAT is likely to
 *   flag (it may reject the record or accept it with errors). AEAT's own validation has more rules than are here, and
 *   remains the authority: a record that passes is not guaranteed to be accepted.
 */

/** The most records in one submission */
export const MaxRecordsPerSubmission = 1000
/** The most breakdown lines in one record */
export const MaxBreakdownLines = 12
/** The most invoices a record can list as corrected or substituted, and the most recipients */
export const MaxListedParties = 1000

const HashPattern = /^[0-9A-F]{64}$/
const TimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

class Collector {
  readonly issues: ValidationIssue[] = []

  error(code: string, path: string, message: string) {
    this.issues.push({ severity: 'error', code, path, message })
  }

  warn(code: string, path: string, message: string) {
    this.issues.push({ severity: 'warning', code, path, message })
  }

  text(path: string, value: string | undefined, max: number, options: { min?: number, required?: boolean } = {}) {
    const min = options.min ?? (options.required ? 1 : 0)
    if (value === undefined || value === null) {
      if (options.required) this.error('required', path, 'is required')
      return
    }
    if (value.length === 0 && options.required) this.error('required', path, 'is required')
    else if (value.length < min) this.error('text-too-short', path, `must be at least ${min} characters`)
    if (value.length > max) this.error('text-too-long', path, `must be at most ${max} characters (it has ${value.length})`)
  }

  nif(path: string, value: string | undefined) {
    if (!value) {
      this.error('required', path, 'is required')
    }
    else if (value.length !== 9) {
      this.error('nif-length', path, `must be exactly 9 characters (it has ${value.length})`)
    }
  }

  date(path: string, value: string | undefined, required = false) {
    if (value === undefined || value === null) {
      if (required) this.error('required', path, 'is required')
    }
    else if (!isIsoDate(value)) {
      this.error('invalid-date', path, `"${value}" is not a calendar date written YYYY-MM-DD`)
    }
  }

  amount(path: string, value: string | undefined, required = false) {
    if (value === undefined || value === null || value === '') {
      if (required) this.error('required', path, 'is required')
    }
    else if (!isAmount(value)) {
      this.error('invalid-amount', path, `"${value}" is not an amount (up to 12 digits, a point, up to 2 decimals)`)
    }
  }

  rate(path: string, value: string | undefined) {
    if (value !== undefined && value !== null && !isRate(value)) {
      this.error('invalid-rate', path, `"${value}" is not a rate (up to 3 digits, a point, up to 2 decimals)`)
    }
  }

  oneOf(path: string, value: string | undefined, allowed: readonly string[], required = false) {
    if (value === undefined || value === null) {
      if (required) this.error('required', path, 'is required')
    }
    else if (!allowed.includes(value)) {
      this.error('invalid-code', path, `"${value}" is not one of ${allowed.join(', ')}`)
    }
  }

  otherId(path: string, other: OtherId | undefined) {
    if (!other) return
    this.oneOf(`${path}.type`, other.type, OtherIdTypes, true)
    this.text(`${path}.id`, other.id, 20, { required: true })
    if (other.countryCode !== undefined && !isCountryCode(other.countryCode)) {
      this.error('invalid-country', `${path}.countryCode`, `"${other.countryCode}" is not a country code AEAT accepts`)
    }
    if (other.type === '02' && !other.countryCode) {
      this.warn('country-expected', `${path}.countryCode`, 'a VAT number from another country should say which country')
    }
  }

  party(path: string, party: Party | undefined) {
    if (!party) return
    this.text(`${path}.name`, party.name, 120, { required: true })
    const hasNif = party.nif !== undefined && party.nif !== null
    const hasOther = !!party.otherId
    if (hasNif === hasOther) {
      this.error('id-choice', path, 'needs exactly one of a Spanish NIF or another identifier')
    }
    if (hasNif) this.nif(`${path}.nif`, party.nif)
    this.otherId(`${path}.otherId`, party.otherId)
  }

  taxpayer(path: string, taxpayer: Taxpayer | undefined, required = true) {
    if (!taxpayer) {
      if (required) this.error('required', path, 'is required')
      return
    }
    this.text(`${path}.name`, taxpayer.name, 120, { required: true })
    this.nif(`${path}.nif`, taxpayer.nif)
  }

  system(path: string, system: SoftwareSystem | undefined) {
    if (!system) {
      this.error('required', path, 'is required')
      return
    }
    this.text(`${path}.producerName`, system.producerName, 120, { required: true })
    const hasNif = !!system.producerNif
    const hasOther = !!system.producerOtherId
    if (hasNif === hasOther) this.error('id-choice', path, 'the producer needs exactly one of a Spanish NIF or another identifier')
    if (hasNif) this.nif(`${path}.producerNif`, system.producerNif)
    this.otherId(`${path}.producerOtherId`, system.producerOtherId)
    this.text(`${path}.name`, system.name, 30, { required: true })
    this.text(`${path}.id`, system.id, 2, { required: true })
    this.text(`${path}.version`, system.version, 50, { required: true })
    this.text(`${path}.installationNumber`, system.installationNumber, 100, { required: true })
  }

  chaining(path: string, chaining: Chaining | undefined) {
    if (!chaining) {
      this.error('required', path, 'is required')
      return
    }
    if (chaining.first) return
    const link = chaining.previous
    if (!link) {
      this.error('required', `${path}.previous`, 'is required unless this is the first record')
      return
    }
    this.nif(`${path}.previous.issuerNif`, link.issuerNif)
    this.text(`${path}.previous.number`, link.number, 60, { required: true })
    this.date(`${path}.previous.issueDate`, link.issueDate, true)
    this.text(`${path}.previous.hash`, link.hash, 64, { required: true })
  }

  generatedAt(path: string, value: string | undefined) {
    if (!value || !TimestampPattern.test(value)) {
      this.error('invalid-timestamp', path, `"${value ?? ''}" is not an ISO 8601 timestamp with an offset, such as 2024-01-01T19:20:30+01:00`)
    }
  }

  hash(record: BillingRecord) {
    if (!HashTypes.includes(record.hashType)) {
      this.error('invalid-code', 'hashType', `"${record.hashType}" is not a hash type AEAT accepts`)
    }
    if (!record.hash || !HashPattern.test(record.hash)) {
      this.error('invalid-hash', 'hash', 'must be 64 upper-case hexadecimal characters')
    }
    else if (!verifyRecordHash(record)) {
      this.warn('hash-mismatch', 'hash', 'does not match the record content: AEAT would accept the record with errors')
    }
  }

  /** A whole number of at most `digits` digits */
  count(path: string, value: number | undefined, digits: number, required = false) {
    if (value === undefined || value === null) {
      if (required) this.error('required', path, 'is required')
    }
    else if (!Number.isInteger(value) || value < 0 || String(value).length > digits) {
      this.error('invalid-count', path, `${value} is not a whole number of at most ${digits} digits`)
    }
  }

  /** The XML of a signature, as `signRecord` makes it */
  signature(path: string, value: string | undefined) {
    if (value !== undefined && !(value.startsWith('<ds:Signature') && value.trimEnd().endsWith('</ds:Signature>'))) {
      this.error('invalid-signature', path, 'must be the <ds:Signature> element as XML text')
    }
  }

  eventLink(path: string, link: EventLink | undefined, required = false) {
    if (!link) {
      if (required) this.error('required', path, 'is required')
      return
    }
    this.oneOf(`${path}.type`, link.type, EventTypes, true)
    this.generatedAt(`${path}.generatedAt`, link.generatedAt)
    this.text(`${path}.hash`, link.hash, 64, { required: true })
  }

  billingLink(path: string, link: { issuerNif: string, number: string, issueDate: string, hash: string } | undefined, required = false) {
    if (!link) {
      if (required) this.error('required', path, 'is required')
      return
    }
    this.nif(`${path}.issuerNif`, link.issuerNif)
    this.text(`${path}.number`, link.number, 60, { required: true })
    this.date(`${path}.issueDate`, link.issueDate, true)
    this.text(`${path}.hash`, link.hash, 64, { required: true })
  }

  invoiceId(path: string, id: BillingRecord['id'] | undefined) {
    if (!id) {
      this.error('required', path, 'is required')
      return
    }
    this.nif(`${path}.issuerNif`, id.issuerNif)
    this.text(`${path}.number`, id.number, 60, { required: true })
    this.date(`${path}.issueDate`, id.issueDate, true)
    if (id.number && !isPrintableAscii(id.number)) {
      this.warn('number-not-ascii', `${path}.number`, 'contains characters outside printable ASCII (32 to 126), which the QR code validation does not accept')
    }
  }
}

function checkBreakdownLine(c: Collector, path: string, line: NormalisedBreakdownLine) {
  c.oneOf(`${path}.tax`, line.tax, Taxes)
  c.oneOf(`${path}.regimeKey`, line.regimeKey, RegimeKeys)
  c.oneOf(`${path}.qualification`, line.qualification, OperationQualifications)
  c.oneOf(`${path}.exemption`, line.exemption, Exemptions)
  c.rate(`${path}.taxRate`, line.taxRate)
  c.amount(`${path}.taxableBase`, line.taxableBase, true)
  c.amount(`${path}.costBase`, line.costBase)
  c.amount(`${path}.taxAmount`, line.taxAmount)
  c.rate(`${path}.surchargeRate`, line.surchargeRate)
  c.amount(`${path}.surchargeAmount`, line.surchargeAmount)

  if (!!line.qualification === !!line.exemption) {
    c.error('qualification-choice', path, 'needs exactly one of a qualification (S1, S2, N1, N2) or an exemption (E1 to E8)')
    return
  }

  if (line.qualification && TaxedQualifications.includes(line.qualification)) {
    if (line.taxRate === undefined || line.taxAmount === undefined) {
      c.warn('tax-expected', path, `a ${line.qualification} operation is taxed, so it should have a tax rate and a tax amount`)
    }
  }
  else if (line.taxRate !== undefined || (line.taxAmount !== undefined && isAmount(line.taxAmount) && toCents(line.taxAmount) !== 0)) {
    c.warn('tax-unexpected', path, 'a not-subject or exempt operation carries no tax rate or amount')
  }
}

/** Checks an *alta* record */
export function validateInvoiceRecord(record: InvoiceRecord): ValidationIssue[] {
  const c = new Collector()

  c.invoiceId('id', record.id)
  c.text('externalRef', record.externalRef, 60)
  c.text('issuerName', record.issuerName, 120, { required: true })
  c.oneOf('invoiceType', record.invoiceType, InvoiceTypes, true)
  c.oneOf('rectification', record.rectification, RectificationTypes)
  c.oneOf('previousRejection', record.previousRejection, PreviousRejections)
  c.oneOf('issuedBy', record.issuedBy, IssuedByOthers)
  c.date('operationDate', record.operationDate)
  c.text('description', record.description, 500, { required: true })
  c.text('billingAgreementNumber', record.billingAgreementNumber, 15)
  c.text('systemAgreementId', record.systemAgreementId, 16)

  for (const [name, list] of [['rectifiedInvoices', record.rectifiedInvoices], ['substitutedInvoices', record.substitutedInvoices]] as const) {
    if (list && list.length > MaxListedParties) c.error('too-many', name, `holds at most ${MaxListedParties} invoices`)
    list?.forEach((ref, index) => c.invoiceId(`${name}[${index}]`, ref))
  }
  if (record.recipients) {
    if (record.recipients.length > MaxListedParties) c.error('too-many', 'recipients', `holds at most ${MaxListedParties} recipients`)
    record.recipients.forEach((party, index) => c.party(`recipients[${index}]`, party))
  }
  c.party('thirdParty', record.thirdParty)

  if (record.rectifiedAmounts) {
    c.amount('rectifiedAmounts.base', record.rectifiedAmounts.base, true)
    c.amount('rectifiedAmounts.tax', record.rectifiedAmounts.tax, true)
    c.amount('rectifiedAmounts.surcharge', record.rectifiedAmounts.surcharge)
  }

  if (!record.breakdown || record.breakdown.length === 0) {
    c.error('required', 'breakdown', 'needs at least one line')
  }
  else if (record.breakdown.length > MaxBreakdownLines) {
    c.error('too-many', 'breakdown', `holds at most ${MaxBreakdownLines} lines (group lines with the same rate and qualification)`)
  }
  record.breakdown?.forEach((line, index) => checkBreakdownLine(c, `breakdown[${index}]`, line))

  c.amount('totalTax', record.totalTax, true)
  c.amount('totalAmount', record.totalAmount, true)
  c.chaining('chaining', record.chaining)
  c.system('system', record.system)
  c.generatedAt('generatedAt', record.generatedAt)
  c.hash(record)
  c.signature('signature', record.signature)

  checkInvoiceBusinessRules(c, record)
  return c.issues
}

function checkInvoiceBusinessRules(c: Collector, record: InvoiceRecord) {
  const corrective = CorrectiveInvoiceTypes.includes(record.invoiceType)
  const recipients = record.recipients?.length ?? 0

  if (corrective) {
    if (!record.rectification) c.warn('rectification-expected', 'rectification', 'a corrective invoice should say whether it is substitutive (S) or incremental (I)')
    if (!record.rectifiedInvoices?.length) c.warn('rectified-expected', 'rectifiedInvoices', 'a corrective invoice should list the invoices it corrects')
    if (record.rectification === 'S' && !record.rectifiedAmounts) c.warn('rectified-amounts-expected', 'rectifiedAmounts', 'a substitutive corrective invoice should give the base and tax it replaces')
  }
  else if (record.rectification || record.rectifiedInvoices?.length || record.rectifiedAmounts) {
    c.warn('rectification-unexpected', 'invoiceType', 'only corrective invoices (R1 to R5) carry rectification details')
  }

  if (record.invoiceType === 'F1' && recipients === 0 && !record.withoutRecipientArt61d) {
    c.warn('recipient-expected', 'recipients', 'a complete invoice (F1) should identify its recipient, unless it is marked as issued without one (article 6.1.d)')
  }
  if ((record.invoiceType === 'F2' || record.invoiceType === 'R5') && recipients > 0) {
    c.warn('recipient-unexpected', 'recipients', 'a simplified invoice does not identify its recipient')
  }
  if (record.invoiceType === 'F3' && !record.substitutedInvoices?.length) {
    c.warn('substituted-expected', 'substitutedInvoices', 'an invoice replacing simplified invoices should list them')
  }
  if (record.previousRejection === 'X' && !record.amendment) {
    c.warn('amendment-expected', 'amendment', 'a record redone after a rejection should also be marked as an amendment (Subsanacion = S)')
  }
  if (record.amendment && record.previousRejection === 'S') {
    c.warn('rejection-code', 'previousRejection', 'for an alta, a previous rejection is X (the record does not exist at AEAT), not S')
  }

  // The totals follow from the breakdown; AEAT checks them with a small tolerance, so a difference of a cent a line is allowed
  try {
    const tax = sumAmounts(record.breakdown.flatMap((line) => [line.taxAmount, line.surchargeAmount]).filter((value): value is string => !!value))
    const total = sumAmounts(record.breakdown.flatMap((line) => [line.taxableBase, line.taxAmount, line.surchargeAmount]).filter((value): value is string => !!value))
    const tolerance = record.breakdown.length
    if (Math.abs(toCents(record.totalTax) - toCents(tax)) > tolerance) {
      c.warn('total-tax-mismatch', 'totalTax', `is ${record.totalTax} but the breakdown's tax adds up to ${tax}`)
    }
    if (Math.abs(toCents(record.totalAmount) - toCents(total)) > tolerance) {
      c.warn('total-amount-mismatch', 'totalAmount', `is ${record.totalAmount} but the breakdown adds up to ${total}`)
    }
  }
  catch {
    // Amounts that cannot be read were reported above
  }
}

/** Checks a *cancellation* record */
export function validateCancellationRecord(record: CancellationRecord): ValidationIssue[] {
  const c = new Collector()

  c.invoiceId('id', record.id)
  c.text('externalRef', record.externalRef, 60)
  c.oneOf('previousRejection', record.previousRejection, ['S', 'N'])
  c.oneOf('generatedBy', record.generatedBy, CancellationGenerators)
  c.party('generator', record.generator)
  c.chaining('chaining', record.chaining)
  c.system('system', record.system)
  c.generatedAt('generatedAt', record.generatedAt)
  c.hash(record)
  c.signature('signature', record.signature)

  if (record.generatedBy && record.generatedBy !== 'E' && !record.generator) {
    c.warn('generator-expected', 'generator', 'a cancellation generated by the recipient or a third party should identify them')
  }
  return c.issues
}

/** The most event types a summary event lists */
export const MaxSummaryEventTypes = 20

function checkAnomalyChecks(c: Collector, path: string, checks: AnomalyChecks, digits: number) {
  for (const name of ['hashes', 'signatures', 'chain', 'dates'] as const) {
    const run = checks[name]
    if (!run) {
      c.error('required', `${path}.${name}`, 'is required')
      continue
    }
    c.count(`${path}.${name}.processed`, run.processed, digits)
    if (run.processed !== undefined && !run.performed) c.warn('processed-unexpected', `${path}.${name}.processed`, 'the check was not performed, so it should not report records processed')
  }
}

function checkEventData(c: Collector, data: EventData) {
  switch (data.kind) {
    case 'billing-anomaly-check':
      checkAnomalyChecks(c, 'data', data, 7)
      break
    case 'event-anomaly-check':
      checkAnomalyChecks(c, 'data', data, 5)
      break
    case 'billing-anomaly':
      c.oneOf('data.anomaly', data.anomaly, AnomalyTypes, true)
      c.text('data.details', data.details, 100)
      if (data.record) c.invoiceId('data.record', data.record)
      break
    case 'event-anomaly':
      c.oneOf('data.anomaly', data.anomaly, AnomalyTypes, true)
      c.text('data.details', data.details, 100)
      c.eventLink('data.event', data.event)
      break
    case 'billing-export':
      c.generatedAt('data.periodStart', String(data.periodStart))
      c.generatedAt('data.periodEnd', String(data.periodEnd))
      c.billingLink('data.first', data.first, true)
      c.billingLink('data.last', data.last, true)
      c.count('data.altaCount', data.altaCount, 9, true)
      c.amount('data.totalTax', String(data.totalTax), true)
      c.amount('data.totalAmount', String(data.totalAmount), true)
      c.count('data.cancellationCount', data.cancellationCount, 9, true)
      break
    case 'event-export':
      c.generatedAt('data.periodStart', String(data.periodStart))
      c.generatedAt('data.periodEnd', String(data.periodEnd))
      c.eventLink('data.first', data.first, true)
      c.eventLink('data.last', data.last, true)
      c.count('data.count', data.count, 7, true)
      break
    case 'summary':
      if (!data.counts || data.counts.length === 0) c.error('required', 'data.counts', 'needs at least one event type')
      else if (data.counts.length > MaxSummaryEventTypes) c.error('too-many', 'data.counts', `holds at most ${MaxSummaryEventTypes} event types`)
      data.counts?.forEach((entry, index) => {
        c.oneOf(`data.counts[${index}].type`, entry.type, EventTypes, true)
        c.count(`data.counts[${index}].count`, entry.count, 4, true)
      })
      c.billingLink('data.firstBilling', data.firstBilling)
      c.billingLink('data.lastBilling', data.lastBilling)
      c.count('data.altaCount', data.altaCount, 6, true)
      c.amount('data.totalTax', String(data.totalTax), true)
      c.amount('data.totalAmount', String(data.totalAmount), true)
      c.count('data.cancellationCount', data.cancellationCount, 6, true)
      break
  }
}

function checkEventChaining(c: Collector, chaining: EventChaining | undefined) {
  if (!chaining) {
    c.error('required', 'chaining', 'is required')
  }
  else if (!chaining.first) {
    if (!chaining.previous) c.error('required', 'chaining.previous', 'is required unless this is the first event')
    c.eventLink('chaining.previous', chaining.previous)
  }
}

/** Checks an *event* record */
export function validateEventRecord(record: EventRecord): ValidationIssue[] {
  const c = new Collector()

  c.oneOf('type', record.type, EventTypes, true)
  c.taxpayer('taxpayer', record.taxpayer)
  c.system('system', record.system)
  c.generatedAt('generatedAt', record.generatedAt)
  c.oneOf('issuedBy', record.issuedBy, IssuedByOthers)
  c.party('thirdParty', record.thirdParty)
  c.text('otherData', record.otherData, 100)
  checkEventChaining(c, record.chaining)

  if (!HashTypes.includes(record.hashType)) c.error('invalid-code', 'hashType', `"${record.hashType}" is not a hash type AEAT accepts`)
  if (!record.hash || !HashPattern.test(record.hash)) c.error('invalid-hash', 'hash', 'must be 64 upper-case hexadecimal characters')
  else if (!verifyEventHash(record)) c.warn('hash-mismatch', 'hash', 'does not match the event content')
  c.signature('signature', record.signature)

  const expected = EventDataKinds[record.type]
  if (expected && record.data?.kind !== expected) {
    c.error('data-expected', 'data', `an event of type ${record.type} needs data of kind "${expected}"`)
  }
  else if (!expected && record.data) {
    c.error('data-unexpected', 'data', `an event of type ${record.type} carries no data (it has "${record.data.kind}")`)
  }
  else if (record.data) {
    checkEventData(c, record.data)
  }

  if (record.type === '90' && !record.otherData) c.warn('description-expected', 'otherData', 'an event of type 90 (other) should say what happened')
  return c.issues
}

/** Checks a submission header */
export function validateHeader(header: SubmissionHeader): ValidationIssue[] {
  const c = new Collector()

  c.taxpayer('taxpayer', header.taxpayer)
  c.taxpayer('representative', header.representative, false)
  if (header.voluntary) {
    c.date('voluntary.verifactuEndDate', header.voluntary.verifactuEndDate)
  }
  if (header.requirement) {
    c.text('requirement.reference', header.requirement.reference, 18, { required: true })
  }
  if (header.voluntary && header.requirement) {
    c.warn('both-modes', 'header', 'a submission is either voluntary (VERI*FACTU mode) or in answer to a requirement, not both')
  }
  return c.issues
}

/**
 * Checks a whole submission: the header, 1 to 1000 records, each valid, all issued by the header's taxpayer, and (as
 * a warning) in chain order. Returns every issue found.
 */
export function validateSubmission(header: SubmissionHeader, records: BillingRecord[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [...validateHeader(header)]

  if (records.length === 0) {
    issues.push({ severity: 'error', code: 'required', path: 'records', message: 'needs at least one record' })
  }
  else if (records.length > MaxRecordsPerSubmission) {
    issues.push({ severity: 'error', code: 'too-many', path: 'records', message: `a submission holds at most ${MaxRecordsPerSubmission} records (it has ${records.length}): send them in batches` })
  }

  records.forEach((record, index) => {
    const found = record.kind === 'alta' ? validateInvoiceRecord(record) : validateCancellationRecord(record)
    issues.push(...found.map((issue) => ({ ...issue, path: `records[${index}].${issue.path}` })))

    if (header.taxpayer && record.id.issuerNif !== header.taxpayer.nif) {
      issues.push({ severity: 'warning', code: 'issuer-differs', path: `records[${index}].id.issuerNif`, message: `is ${record.id.issuerNif} but the header's taxpayer is ${header.taxpayer.nif}` })
    }
    if (index > 0) {
      const before = records[index - 1]
      const link = record.chaining.first ? null : record.chaining.previous
      if (!link || link.hash !== before.hash) {
        issues.push({ severity: 'warning', code: 'out-of-order', path: `records[${index}].chaining`, message: `does not chain to the record before it in this submission (${before.id.number}): send records in the order they were generated` })
      }
    }
  })
  return issues
}

/** Throws `VerifactuValidationError` when there is any error (warnings alone do not throw) */
export function assertNoErrors(issues: ValidationIssue[]): void {
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new VerifactuValidationError(issues)
  }
}
