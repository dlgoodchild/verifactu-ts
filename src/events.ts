import { Sha256HashType, type AnomalyType, type EventType, type HashType, type IssuedByOther } from '~/codes'
import { formatAmount, formatTimestamp, cleanText } from '~/format'
import { calculateEventRecordHash, verifyEventHash } from '~/hash'
import { assertNoErrors, validateEventRecord } from '~/validate'
import type { Amount, ChainLink, InvoiceId, Party, SoftwareSystem, Taxpayer } from '~/types'

/**
 * Event records (*registros de evento*): the log a non-VERI*FACTU system keeps of what the software itself did (it
 * started or stopped, it checked its records for tampering, it exported records, ...). Like billing records, each event
 * record carries a hash that includes the previous event's hash, forming a chain, and must be signed. See the README,
 * "The two ways to comply". VERI*FACTU systems do not need an event log.
 */

/** The previous event in the chain, whose hash the next event includes (`EventoAnterior`) */
export interface EventLink {
  /** `TipoEvento` of that event */
  type: EventType
  /** `FechaHoraHusoGenEvento` of that event */
  generatedAt: string
  /** `HuellaEvento` of that event */
  hash: string
}

/** `Encadenamiento` of an event: the first event (`first: true`), or the link to the one before */
export interface EventChaining {
  first?: boolean
  previous?: EventLink
}

/** One run of an anomaly check: whether it was done, and over how many records */
export interface CheckRun {
  performed: boolean
  /** How many records it processed (at most 7 digits for billing records, 5 for event records) */
  processed?: number
}

/** The checks a "launch of the anomaly detection process" event reports (events 03 and 05) */
export interface AnomalyChecks {
  /** Were the hashes checked (do they match the content)? */
  hashes: CheckRun
  /** Were the signatures checked? */
  signatures: CheckRun
  /** Was the chain checked (is every record linked to its neighbours)? */
  chain: CheckRun
  /** Were the dates checked (do they run forward along the chain)? */
  dates: CheckRun
}

/** A moment, as a `Date` or an ISO 8601 text with an offset */
export type Moment = Date | string

/** `DatosPropiosEvento`: the details particular to some kinds of event. The `kind` must match the event's `type`. */
export type EventData =
  /** Event 03: the check for anomalies in billing records was launched */
  | ({ kind: 'billing-anomaly-check' } & AnomalyChecks)
  /** Event 04: an anomaly was found in a billing record */
  | { kind: 'billing-anomaly', anomaly: AnomalyType, details?: string, record?: InvoiceId }
  /** Event 05: the check for anomalies in event records was launched */
  | ({ kind: 'event-anomaly-check' } & AnomalyChecks)
  /** Event 06: an anomaly was found in an event record */
  | { kind: 'event-anomaly', anomaly: AnomalyType, details?: string, event?: EventLink }
  /** Event 08: billing records of a period were exported */
  | {
    kind: 'billing-export'
    periodStart: Moment
    periodEnd: Moment
    first: ChainLink
    last: ChainLink
    /** How many *alta* records were exported (at most 9 digits) */
    altaCount: number
    totalTax: Amount
    totalAmount: Amount
    /** How many *anulación* records were exported (at most 9 digits) */
    cancellationCount: number
    /** The exported records are no longer kept in the system */
    noLongerKept: boolean
  }
  /** Event 09: event records of a period were exported */
  | { kind: 'event-export', periodStart: Moment, periodEnd: Moment, first: EventLink, last: EventLink, count: number, noLongerKept: boolean }
  /** Event 10: a summary of the events (and the billing records) since the last summary */
  | {
    kind: 'summary'
    /** How many events of each type (at most 20 types) */
    counts: Array<{ type: EventType, count: number }>
    firstBilling?: ChainLink
    lastBilling?: ChainLink
    altaCount: number
    totalTax: Amount
    totalAmount: Amount
    cancellationCount: number
  }

/** The kind of data each event type carries (the others carry none) */
export const EventDataKinds: Partial<Record<EventType, EventData['kind']>> = {
  '03': 'billing-anomaly-check',
  '04': 'billing-anomaly',
  '05': 'event-anomaly-check',
  '06': 'event-anomaly',
  '08': 'billing-export',
  '09': 'event-export',
  '10': 'summary'
}

/** What it takes to describe an event: the rest (chain, hash, formatting) is worked out */
export interface EventRecordInput {
  /** `TipoEvento` */
  type: EventType
  /** `ObligadoEmision`: the taxpayer the software is used for */
  taxpayer: Taxpayer
  /** `SistemaInformatico`: the software */
  system: SoftwareSystem
  /** `FechaHoraHusoGenEvento` */
  generatedAt: Moment
  /** `DatosPropiosEvento`: required for types 03 to 06 and 08 to 10, and not allowed for the others */
  data?: EventData
  /** `OtrosDatosEvento`: free text, at most 100 characters (the description of an event of type 90, for example) */
  otherData?: string
  /** `EmitidaPorTerceroODestinatario`: the event was caused by a third party (`T`) or the recipient (`D`) */
  issuedBy?: IssuedByOther
  /** `TerceroODestinatario` */
  thirdParty?: Party
}

/** A complete event record: what is logged, signed and exported */
export interface EventRecord {
  kind: 'evento'
  type: EventType
  taxpayer: Taxpayer
  system: SoftwareSystem
  generatedAt: string
  data?: EventData
  otherData?: string
  issuedBy?: IssuedByOther
  thirdParty?: Party
  chaining: EventChaining
  hashType: HashType
  /** `HuellaEvento`: 64 upper-case hexadecimal characters */
  hash: string
  /** `ds:Signature`: the XAdES signature (XML text), set by `signEventRecord` */
  signature?: string
}

const timestamp = (value: Moment): string => formatTimestamp(value)

const normaliseChecks = (checks: AnomalyChecks): AnomalyChecks => ({
  hashes: { ...checks.hashes },
  signatures: { ...checks.signatures },
  chain: { ...checks.chain },
  dates: { ...checks.dates }
})

const normaliseEventLink = (link: EventLink): EventLink => ({ type: link.type, generatedAt: timestamp(link.generatedAt), hash: link.hash })

/** Writes the timestamps and amounts of an event's data the way AEAT wants them */
function normaliseData(data: EventData): EventData {
  switch (data.kind) {
    case 'billing-anomaly-check':
    case 'event-anomaly-check':
      return { kind: data.kind, ...normaliseChecks(data) }
    case 'billing-anomaly':
      return { ...data, details: data.details === undefined ? undefined : cleanText(data.details) }
    case 'event-anomaly':
      return { ...data, details: data.details === undefined ? undefined : cleanText(data.details), event: data.event ? normaliseEventLink(data.event) : undefined }
    case 'billing-export':
      return { ...data, periodStart: timestamp(data.periodStart), periodEnd: timestamp(data.periodEnd), totalTax: formatAmount(data.totalTax), totalAmount: formatAmount(data.totalAmount) }
    case 'event-export':
      return { ...data, periodStart: timestamp(data.periodStart), periodEnd: timestamp(data.periodEnd), first: normaliseEventLink(data.first), last: normaliseEventLink(data.last) }
    case 'summary':
      return { ...data, totalTax: formatAmount(data.totalTax), totalAmount: formatAmount(data.totalAmount) }
  }
}

export interface CreateEventOptions {
  /** Set false to skip the local check (default true: errors throw `VerifactuValidationError`) */
  validate?: boolean
}

/**
 * Builds an event record: writes its values the way AEAT wants them, chains it to the event before it (`previous`, or
 * `null` for the very first event), and calculates its hash. Sign it with `signEventRecord` before logging it.
 */
export function createEventRecord(input: EventRecordInput, previous: EventLink | null = null, options: CreateEventOptions = {}): EventRecord {
  const generatedAt = timestamp(input.generatedAt)
  const record: EventRecord = {
    kind: 'evento',
    type: input.type,
    taxpayer: { name: cleanText(input.taxpayer.name), nif: cleanText(input.taxpayer.nif) },
    system: input.system,
    generatedAt,
    data: input.data ? normaliseData(input.data) : undefined,
    otherData: input.otherData === undefined ? undefined : cleanText(input.otherData),
    issuedBy: input.issuedBy,
    thirdParty: input.thirdParty,
    chaining: previous ? { previous: normaliseEventLink(previous) } : { first: true },
    hashType: Sha256HashType,
    hash: ''
  }
  record.hash = calculateEventRecordHash(record)
  if (options.validate !== false) assertNoErrors(validateEventRecord(record))
  return record
}

/** The link to pass as `previous` when creating the event that follows this one */
export function eventLinkOf(record: EventRecord): EventLink {
  return { type: record.type, generatedAt: record.generatedAt, hash: record.hash }
}

/** A problem found in an event chain */
export interface EventChainProblem {
  /** Position of the event in the list */
  index: number
  code: 'bad-hash' | 'bad-link' | 'missing-first' | 'unexpected-first'
  message: string
}

/**
 * Checks events in order: each hash matches its content, and each event links to the one before it. Pass `previous`
 * when the list does not start at the first event ever logged.
 */
export function verifyEventChain(records: EventRecord[], previous: EventLink | null = null): EventChainProblem[] {
  const problems: EventChainProblem[] = []
  let expected = previous
  records.forEach((record, index) => {
    if (!verifyEventHash(record)) {
      problems.push({ index, code: 'bad-hash', message: `Event ${index + 1} (${record.type}, ${record.generatedAt}) does not match its hash: it was changed, or its hash was wrongly calculated` })
    }
    if (record.chaining.first) {
      if (expected) problems.push({ index, code: 'unexpected-first', message: `Event ${index + 1} says it is the first, but there are events before it` })
    }
    else if (!expected) {
      problems.push({ index, code: 'missing-first', message: `Event ${index + 1} links to an earlier event, but it is the first in the list` })
    }
    else if (!record.chaining.previous || record.chaining.previous.hash !== expected.hash || record.chaining.previous.type !== expected.type || record.chaining.previous.generatedAt !== expected.generatedAt) {
      problems.push({ index, code: 'bad-link', message: `Event ${index + 1} does not link to the event before it: an event may have been removed or reordered` })
    }
    expected = eventLinkOf(record)
  })
  return problems
}
