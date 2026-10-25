import { createHash } from 'crypto'
import { cleanText, toAeatDate } from '~/format'
import { Sha256HashType } from '~/codes'
import type { EventRecord } from '~/events'
import type { BillingRecord, ChainLink, Chaining } from '~/types'

/**
 * The hash (*huella*) of a record, and the chain it forms. Follows AEAT's document "Detalle de las especificaciones
 * técnicas para generación de la huella o hash de los registros de facturación" (v0.1.2):
 *
 * - Take the named fields in the order given, as `name=value` joined by `&`, values trimmed, a missing value written as
 *   `name=` with nothing after it.
 * - Encode that text as UTF-8, apply SHA-256, and write the result as 64 upper-case hexadecimal characters.
 * - The previous record's hash is one of the fields, which is what chains the records. The first record has none.
 */

/** SHA-256 of the UTF-8 text as 64 upper-case hexadecimal characters */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
}

const joinFields = (fields: Array<[string, string | undefined | null]>): string =>
  fields.map(([name, value]) => `${name}=${cleanText(value ?? '')}`).join('&')

/** The fields an *alta* record's hash covers, with their values as they appear in the XML (dates as `dd-mm-yyyy`) */
export interface InvoiceHashFields {
  issuerNif: string
  number: string
  /** `dd-mm-yyyy` */
  issueDate: string
  invoiceType: string
  totalTax: string
  totalAmount: string
  /** The previous record's hash; empty for the first record */
  previousHash?: string
  generatedAt: string
}

/** The text an *alta* hash is calculated over (exposed so it can be shown or tested) */
export function invoiceHashInput(fields: InvoiceHashFields): string {
  return joinFields([
    ['IDEmisorFactura', fields.issuerNif],
    ['NumSerieFactura', fields.number],
    ['FechaExpedicionFactura', fields.issueDate],
    ['TipoFactura', fields.invoiceType],
    ['CuotaTotal', fields.totalTax],
    ['ImporteTotal', fields.totalAmount],
    ['Huella', fields.previousHash],
    ['FechaHoraHusoGenRegistro', fields.generatedAt]
  ])
}

export const computeInvoiceHash = (fields: InvoiceHashFields): string => sha256Hex(invoiceHashInput(fields))

/** The fields a *cancellation* record's hash covers */
export interface CancellationHashFields {
  issuerNif: string
  number: string
  /** `dd-mm-yyyy` */
  issueDate: string
  previousHash?: string
  generatedAt: string
}

export function cancellationHashInput(fields: CancellationHashFields): string {
  return joinFields([
    ['IDEmisorFacturaAnulada', fields.issuerNif],
    ['NumSerieFacturaAnulada', fields.number],
    ['FechaExpedicionFacturaAnulada', fields.issueDate],
    ['Huella', fields.previousHash],
    ['FechaHoraHusoGenRegistro', fields.generatedAt]
  ])
}

export const computeCancellationHash = (fields: CancellationHashFields): string => sha256Hex(cancellationHashInput(fields))

/**
 * The fields an *event* record's hash covers. Event records belong to systems that do *not* issue verifiable invoices;
 * see `createEventRecord` (events.ts) for building them.
 */
export interface EventHashFields {
  /** The producer's NIF (give this or `producerOtherId`) */
  producerNif?: string
  /** The producer's `IDOtro/ID` */
  producerOtherId?: string
  systemId: string
  version: string
  installationNumber: string
  /** The NIF of whoever is obliged to issue invoices */
  taxpayerNif: string
  eventType: string
  /** The previous event's hash; empty for the first event */
  previousHash?: string
  generatedAt: string
}

export function eventHashInput(fields: EventHashFields): string {
  return joinFields([
    ['NIF', fields.producerNif],
    ['ID', fields.producerOtherId],
    ['IdSistemaInformatico', fields.systemId],
    ['Version', fields.version],
    ['NumeroInstalacion', fields.installationNumber],
    ['NIF', fields.taxpayerNif],
    ['TipoEvento', fields.eventType],
    ['HuellaEvento', fields.previousHash],
    ['FechaHoraHusoGenEvento', fields.generatedAt]
  ])
}

export const computeEventHash = (fields: EventHashFields): string => sha256Hex(eventHashInput(fields))

const previousHashOf = (chaining: Chaining): string => (chaining.first ? '' : (chaining.previous?.hash ?? ''))

/** The hash a record should have, calculated again from its content (not from its `hash` field) */
export function calculateRecordHash(record: BillingRecord): string {
  if (record.kind === 'alta') {
    return computeInvoiceHash({
      issuerNif: record.id.issuerNif,
      number: record.id.number,
      issueDate: toAeatDate(record.id.issueDate),
      invoiceType: record.invoiceType,
      totalTax: record.totalTax,
      totalAmount: record.totalAmount,
      previousHash: previousHashOf(record.chaining),
      generatedAt: record.generatedAt
    })
  }
  return computeCancellationHash({
    issuerNif: record.id.issuerNif,
    number: record.id.number,
    issueDate: toAeatDate(record.id.issueDate),
    previousHash: previousHashOf(record.chaining),
    generatedAt: record.generatedAt
  })
}

/** Whether the record's `hash` is what its content gives. AEAT marks a record whose hash differs as accepted with errors. */
export function verifyRecordHash(record: BillingRecord): boolean {
  try {
    return record.hashType === Sha256HashType && record.hash === calculateRecordHash(record)
  }
  catch {
    // A date that does not exist or a missing field: the content cannot be hashed, so it cannot match
    return false
  }
}

/** What the next record chains to: the identity and hash of this one */
export function chainLinkOf(record: BillingRecord): ChainLink {
  return { issuerNif: record.id.issuerNif, number: record.id.number, issueDate: record.id.issueDate, hash: record.hash }
}

/** What is wrong with a chain, found by `verifyChain` */
export interface ChainProblem {
  /** Position in the list given, from 0 */
  index: number
  code: 'bad-hash' | 'bad-link' | 'unexpected-first' | 'missing-first'
  message: string
}

/**
 * Checks a run of records in the order they were generated: every hash matches its content, and every record points
 * at the one before it. `previous` is the record before the run (none when the run starts the chain).
 */
export function verifyChain(records: BillingRecord[], previous: ChainLink | null = null): ChainProblem[] {
  const problems: ChainProblem[] = []
  let expected: ChainLink | null = previous

  records.forEach((record, index) => {
    if (!verifyRecordHash(record)) {
      problems.push({ index, code: 'bad-hash', message: `The hash of ${record.id.number} does not match its content` })
    }

    if (expected === null) {
      if (!record.chaining.first) {
        problems.push({ index, code: 'missing-first', message: `${record.id.number} chains to a record, but the chain has none before it` })
      }
    }
    else if (record.chaining.first) {
      problems.push({ index, code: 'unexpected-first', message: `${record.id.number} claims to start the chain, but a record comes before it` })
    }
    else {
      const link = record.chaining.previous
      if (link.hash !== expected.hash || link.number !== expected.number || link.issuerNif !== expected.issuerNif || link.issueDate !== expected.issueDate) {
        problems.push({ index, code: 'bad-link', message: `${record.id.number} does not chain to the record before it (${expected.number})` })
      }
    }

    expected = chainLinkOf(record)
  })

  return problems
}

/** The hash an event record should have, calculated again from its content */
export function calculateEventRecordHash(record: EventRecord): string {
  return computeEventHash({
    producerNif: record.system.producerNif,
    producerOtherId: record.system.producerOtherId?.id,
    systemId: record.system.id,
    version: record.system.version,
    installationNumber: record.system.installationNumber,
    taxpayerNif: record.taxpayer.nif,
    eventType: record.type,
    previousHash: record.chaining.first ? '' : (record.chaining.previous?.hash ?? ''),
    generatedAt: record.generatedAt
  })
}

/** True when the stored hash matches the record's content */
export function verifyEventHash(record: EventRecord): boolean {
  try {
    return record.hash === calculateEventRecordHash(record)
  }
  catch {
    return false
  }
}
