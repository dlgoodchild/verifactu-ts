import { Sha256HashType } from '~/codes'
import { VerifactuValidationError } from '~/errors'
import { cleanText, formatAmount, formatRate, formatTimestamp, sumAmounts, toAeatDate } from '~/format'
import { computeCancellationHash, computeInvoiceHash } from '~/hash'
import { validateCancellationRecord, validateInvoiceRecord } from '~/validate'
import type {
  Amount, BreakdownLine, CancellationRecord, CancellationRecordInput, ChainLink, Chaining, InvoiceRecord, InvoiceRecordInput, NormalisedBreakdownLine,
  Party, ValidationIssue
} from '~/types'

/**
 * Building records: takes plain input, writes every value the way AEAT wants it, chains the record to the one before,
 * and calculates its hash. The result is exactly what `buildSubmissionXml` sends and `verifyRecordHash` checks.
 */

export interface CreateRecordOptions {
  /** Set false to skip validation (not recommended): a record that fails it is likely to be rejected */
  validate?: boolean
  /** The time zone a `Date` for `generatedAt` is written in, default Europe/Madrid */
  timeZone?: string
}

/** Runs a conversion, turning a bad value into a validation issue instead of an exception */
function convert<T>(issues: ValidationIssue[], path: string, run: () => T): T | undefined {
  try {
    return run()
  }
  catch (error) {
    issues.push({ severity: 'error', code: 'invalid-format', path, message: (error as Error).message })
    return undefined
  }
}

const trimOrUndefined = (text: string | undefined): string | undefined => (text === undefined ? undefined : cleanText(text))

const normaliseParty = (party: Party): Party => ({
  name: cleanText(party.name),
  ...(party.nif !== undefined ? { nif: cleanText(party.nif) } : {}),
  ...(party.otherId ? { otherId: { ...party.otherId, ...(party.otherId.countryCode ? { countryCode: cleanText(party.otherId.countryCode) } : {}), id: cleanText(party.otherId.id) } } : {})
})

function normaliseBreakdown(lines: BreakdownLine[], issues: ValidationIssue[]): NormalisedBreakdownLine[] {
  return lines.map((line, index) => {
    const path = `breakdown[${index}]`
    const amount = (field: keyof BreakdownLine, value: Amount | undefined) =>
      value === undefined ? undefined : convert(issues, `${path}.${field}`, () => formatAmount(value))
    const rate = (field: keyof BreakdownLine, value: Amount | undefined) =>
      value === undefined ? undefined : convert(issues, `${path}.${field}`, () => formatRate(value))

    const normalised: NormalisedBreakdownLine = {
      ...(line.tax ? { tax: line.tax } : {}),
      ...(line.regimeKey ? { regimeKey: line.regimeKey } : {}),
      ...(line.qualification ? { qualification: line.qualification } : {}),
      ...(line.exemption ? { exemption: line.exemption } : {}),
      taxableBase: convert(issues, `${path}.taxableBase`, () => formatAmount(line.taxableBase)) ?? ''
    }
    const fields: Array<[keyof NormalisedBreakdownLine, string | undefined]> = [
      ['taxRate', rate('taxRate', line.taxRate)],
      ['costBase', amount('costBase', line.costBase)],
      ['taxAmount', amount('taxAmount', line.taxAmount)],
      ['surchargeRate', rate('surchargeRate', line.surchargeRate)],
      ['surchargeAmount', amount('surchargeAmount', line.surchargeAmount)]
    ]
    for (const [name, value] of fields) {
      if (value !== undefined) {
        (normalised as unknown as Record<string, string>)[name] = value
      }
    }
    return normalised
  })
}

const chainingOf = (previous: ChainLink | null | undefined): Chaining =>
  previous ? { previous: { issuerNif: cleanText(previous.issuerNif), number: cleanText(previous.number), issueDate: previous.issueDate, hash: previous.hash } } : { first: true }

/**
 * Builds an *alta* record for an invoice. `previous` is the record generated just before this one (its identity and
 * hash, from `chainLinkOf`), or null for the first record of the chain. Throws `VerifactuValidationError` when the
 * input is invalid.
 */
export function createInvoiceRecord(input: InvoiceRecordInput, previous: ChainLink | null = null, options: CreateRecordOptions = {}): InvoiceRecord {
  const issues: ValidationIssue[] = []

  const breakdown = normaliseBreakdown(input.breakdown ?? [], issues)
  const totalTax = convert(issues, 'totalTax', () => input.totalTax !== undefined
    ? formatAmount(input.totalTax)
    : sumAmounts(breakdown.flatMap((line) => [line.taxAmount, line.surchargeAmount]).filter((value): value is string => value !== undefined)))
  const totalAmount = convert(issues, 'totalAmount', () => input.totalAmount !== undefined
    ? formatAmount(input.totalAmount)
    : sumAmounts(breakdown.flatMap((line) => [line.taxableBase, line.taxAmount, line.surchargeAmount]).filter((value): value is string => value !== undefined && value !== '')))
  const generatedAt = convert(issues, 'generatedAt', () => formatTimestamp(input.generatedAt, options.timeZone))
  const rectifiedAmounts = input.rectifiedAmounts && {
    base: convert(issues, 'rectifiedAmounts.base', () => formatAmount(input.rectifiedAmounts!.base)) ?? '',
    tax: convert(issues, 'rectifiedAmounts.tax', () => formatAmount(input.rectifiedAmounts!.tax)) ?? '',
    ...(input.rectifiedAmounts.surcharge !== undefined ? { surcharge: convert(issues, 'rectifiedAmounts.surcharge', () => formatAmount(input.rectifiedAmounts!.surcharge!)) ?? '' } : {})
  }

  const id = { issuerNif: cleanText(input.id.issuerNif), number: cleanText(input.id.number), issueDate: input.id.issueDate }
  const dateIssue = convert(issues, 'id.issueDate', () => toAeatDate(input.id.issueDate))

  const record: InvoiceRecord = {
    kind: 'alta',
    id,
    ...(input.externalRef !== undefined ? { externalRef: trimOrUndefined(input.externalRef) } : {}),
    issuerName: cleanText(input.issuerName),
    ...(input.amendment !== undefined ? { amendment: input.amendment } : {}),
    ...(input.previousRejection !== undefined ? { previousRejection: input.previousRejection } : {}),
    invoiceType: input.invoiceType,
    ...(input.rectification ? { rectification: input.rectification } : {}),
    ...(input.rectifiedInvoices ? { rectifiedInvoices: input.rectifiedInvoices.map((ref) => ({ ...ref, issuerNif: cleanText(ref.issuerNif), number: cleanText(ref.number) })) } : {}),
    ...(input.substitutedInvoices ? { substitutedInvoices: input.substitutedInvoices.map((ref) => ({ ...ref, issuerNif: cleanText(ref.issuerNif), number: cleanText(ref.number) })) } : {}),
    ...(rectifiedAmounts ? { rectifiedAmounts } : {}),
    ...(input.operationDate ? { operationDate: input.operationDate } : {}),
    description: cleanText(input.description),
    ...(input.qualifiedSimplified !== undefined ? { qualifiedSimplified: input.qualifiedSimplified } : {}),
    ...(input.withoutRecipientArt61d !== undefined ? { withoutRecipientArt61d: input.withoutRecipientArt61d } : {}),
    ...(input.macrodata !== undefined ? { macrodata: input.macrodata } : {}),
    ...(input.issuedBy ? { issuedBy: input.issuedBy } : {}),
    ...(input.thirdParty ? { thirdParty: normaliseParty(input.thirdParty) } : {}),
    ...(input.recipients ? { recipients: input.recipients.map(normaliseParty) } : {}),
    ...(input.coupon !== undefined ? { coupon: input.coupon } : {}),
    breakdown,
    totalTax: totalTax ?? '',
    totalAmount: totalAmount ?? '',
    chaining: chainingOf(previous),
    system: input.system,
    generatedAt: generatedAt ?? '',
    ...(input.billingAgreementNumber ? { billingAgreementNumber: cleanText(input.billingAgreementNumber) } : {}),
    ...(input.systemAgreementId ? { systemAgreementId: cleanText(input.systemAgreementId) } : {}),
    hashType: Sha256HashType,
    hash: ''
  }

  if (issues.length > 0) {
    throw new VerifactuValidationError(issues)
  }

  record.hash = computeInvoiceHash({
    issuerNif: id.issuerNif,
    number: id.number,
    issueDate: dateIssue!,
    invoiceType: record.invoiceType,
    totalTax: record.totalTax,
    totalAmount: record.totalAmount,
    previousHash: record.chaining.first ? '' : record.chaining.previous.hash,
    generatedAt: record.generatedAt
  })

  if (options.validate !== false) {
    const found = validateInvoiceRecord(record)
    if (found.some((issue) => issue.severity === 'error')) {
      throw new VerifactuValidationError(found)
    }
  }
  return record
}

/**
 * Builds a *cancellation* (*anulación*) record. It cancels the *record* of an invoice issued in error; an invoice that
 * was really issued and now changes needs a corrective invoice instead (an *alta* with a corrective type).
 */
export function createCancellationRecord(input: CancellationRecordInput, previous: ChainLink | null = null, options: CreateRecordOptions = {}): CancellationRecord {
  const issues: ValidationIssue[] = []
  const generatedAt = convert(issues, 'generatedAt', () => formatTimestamp(input.generatedAt, options.timeZone))
  const dateIssue = convert(issues, 'id.issueDate', () => toAeatDate(input.id.issueDate))
  if (issues.length > 0) {
    throw new VerifactuValidationError(issues)
  }

  const id = { issuerNif: cleanText(input.id.issuerNif), number: cleanText(input.id.number), issueDate: input.id.issueDate }
  const record: CancellationRecord = {
    kind: 'anulacion',
    id,
    ...(input.externalRef !== undefined ? { externalRef: trimOrUndefined(input.externalRef) } : {}),
    ...(input.withoutPreviousRecord !== undefined ? { withoutPreviousRecord: input.withoutPreviousRecord } : {}),
    ...(input.previousRejection ? { previousRejection: input.previousRejection } : {}),
    ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
    ...(input.generator ? { generator: normaliseParty(input.generator) } : {}),
    chaining: chainingOf(previous),
    system: input.system,
    generatedAt: generatedAt!,
    hashType: Sha256HashType,
    hash: ''
  }
  record.hash = computeCancellationHash({
    issuerNif: id.issuerNif,
    number: id.number,
    issueDate: dateIssue!,
    previousHash: record.chaining.first ? '' : record.chaining.previous.hash,
    generatedAt: record.generatedAt
  })

  if (options.validate !== false) {
    const found = validateCancellationRecord(record)
    if (found.some((issue) => issue.severity === 'error')) {
      throw new VerifactuValidationError(found)
    }
  }
  return record
}

/**
 * The input for a record that corrects one AEAT already **accepted** (no corrective invoice needed): the same
 * invoice identity with the right data, marked `Subsanacion = S`. It is a new record with a new hash, chained like any
 * other; the original stays as it was.
 */
export function asAmendment(input: InvoiceRecordInput): InvoiceRecordInput {
  return { ...input, amendment: true, previousRejection: input.previousRejection === 'X' ? 'X' : 'N' }
}

/**
 * The input for a record that redoes an initial *alta* AEAT **rejected** (so AEAT does not hold it): marked
 * `Subsanacion = S` and `RechazoPrevio = X`.
 */
export function afterRejection(input: InvoiceRecordInput): InvoiceRecordInput {
  return { ...input, amendment: true, previousRejection: 'X' }
}

/** The input for a cancellation that redoes one AEAT **rejected**: marked `RechazoPrevio = S` */
export function cancellationAfterRejection(input: CancellationRecordInput): CancellationRecordInput {
  return { ...input, previousRejection: 'S' }
}
