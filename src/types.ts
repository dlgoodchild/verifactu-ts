import type {
  CancellationGenerator, HashType, InvoiceType, IssuedByOther, OperationQualification, Exemption, OtherIdType, Period, PreviousRejection,
  RecordStatus, RectificationType, RegimeKey, StoredRecordStatus, SubmissionStatus, Tax
} from '~/codes'

/**
 * The types of the VERI*FACTU client. Names are in English; each field says which XML element of AEAT's schema it is.
 * Dates are calendar dates as `YYYY-MM-DD` (no time zone to get wrong); amounts are decimals in euros as a number or a
 * string, and are written with two decimals.
 */

/** A calendar date, `YYYY-MM-DD` */
export type IsoDate = string

/** A decimal amount in euros, e.g. `12.35`, `"12.35"` or `"-5"` */
export type Amount = number | string

/** A Spanish person or company (`PersonaFisicaJuridicaESType`) */
export interface Taxpayer {
  /** `NombreRazon` (at most 120 characters) */
  name: string
  /** `NIF` (9 characters) */
  nif: string
}

/** An identifier for someone without a Spanish NIF (`IDOtro`) */
export interface OtherId {
  /** `CodigoPais`: left out for the passport-like kinds that do not need one */
  countryCode?: string
  /** `IDType` */
  type: OtherIdType
  /** `ID` (at most 20 characters) */
  id: string
}

/** A recipient, third party or generator (`PersonaFisicaJuridicaType`): a name and either a Spanish NIF or another ID */
export interface Party {
  name: string
  nif?: string
  otherId?: OtherId
}

/** The identity of an invoice (`IDFactura`), which is also the identity of its record */
export interface InvoiceId {
  /** `IDEmisorFactura`: the NIF of whoever issues the invoice */
  issuerNif: string
  /** `NumSerieFactura`: series and number, 1 to 60 characters */
  number: string
  /** `FechaExpedicionFactura` */
  issueDate: IsoDate
}

/** The software that generates the records (`SistemaInformatico`) */
export interface SoftwareSystem {
  /** `NombreRazon`: the producer of the software */
  producerName: string
  /** `NIF` of the producer, when Spanish */
  producerNif?: string
  /** `IDOtro` of the producer, when not Spanish */
  producerOtherId?: OtherId
  /** `NombreSistemaInformatico` (at most 30 characters) */
  name: string
  /** `IdSistemaInformatico` (at most 2 characters) */
  id: string
  /** `Version` (at most 50 characters) */
  version: string
  /** `NumeroInstalacion` (at most 100 characters): identifies this installation of the software */
  installationNumber: string
  /** `TipoUsoPosibleSoloVerifactu`: the software can only be used in VERI*FACTU mode */
  onlyVerifactu: boolean
  /** `TipoUsoPosibleMultiOT`: the software can be used by several taxpayers */
  multiTaxpayer: boolean
  /** `IndicadorMultiplesOT`: this installation is being used by several taxpayers */
  multipleTaxpayersInUse: boolean
}

/** The record before this one in the chain, whose hash the next record includes (`RegistroAnterior`) */
export interface ChainLink {
  issuerNif: string
  number: string
  issueDate: IsoDate
  /** `Huella` of that record */
  hash: string
}

/**
 * `Encadenamiento`: the first record of a chain (`first: true`, no `previous`), or the link to the record before it
 * (`previous`). Exactly one of the two is set.
 */
export interface Chaining {
  first?: boolean
  previous?: ChainLink
}

/** An invoice referred to by a corrective or substituting invoice (`IDFacturaARType`) */
export interface InvoiceRef {
  issuerNif: string
  number: string
  issueDate: IsoDate
}

/** One line of the tax breakdown (`DetalleDesglose`): up to 12 per record */
export interface BreakdownLine {
  /** `Impuesto`: which tax; VAT when left out */
  tax?: Tax
  /** `ClaveRegimen` */
  regimeKey?: RegimeKey
  /** `CalificacionOperacion`: use this *or* `exemption`, never both */
  qualification?: OperationQualification
  /** `OperacionExenta` */
  exemption?: Exemption
  /** `TipoImpositivo`: percent, e.g. 21 */
  taxRate?: Amount
  /** `BaseImponibleOimporteNoSujeto`: the taxable base, or the amount of a not-subject operation */
  taxableBase: Amount
  /** `BaseImponibleACoste` */
  costBase?: Amount
  /** `CuotaRepercutida`: the tax charged */
  taxAmount?: Amount
  /** `TipoRecargoEquivalencia`: percent */
  surchargeRate?: Amount
  /** `CuotaRecargoEquivalencia` */
  surchargeAmount?: Amount
}

/** The amounts a substitutive corrective invoice replaces (`ImporteRectificacion`) */
export interface RectifiedAmounts {
  /** `BaseRectificada` */
  base: Amount
  /** `CuotaRectificada` */
  tax: Amount
  /** `CuotaRecargoRectificado` */
  surcharge?: Amount
}

/** What it takes to describe an invoice for its *alta* record: the rest (chain, hash, totals) is worked out */
export interface InvoiceRecordInput {
  id: InvoiceId
  /** `RefExterna`: your own reference, up to 60 characters */
  externalRef?: string
  /** `NombreRazonEmisor` (at most 120 characters) */
  issuerName: string
  /** `Subsanacion`: this record corrects one AEAT already holds */
  amendment?: boolean
  /** `RechazoPrevio` */
  previousRejection?: PreviousRejection
  /** `TipoFactura` */
  invoiceType: InvoiceType
  /** `TipoRectificativa`: for corrective invoices */
  rectification?: RectificationType
  /** `FacturasRectificadas`: up to 1000 */
  rectifiedInvoices?: InvoiceRef[]
  /** `FacturasSustituidas`: up to 1000 */
  substitutedInvoices?: InvoiceRef[]
  /** `ImporteRectificacion` */
  rectifiedAmounts?: RectifiedAmounts
  /** `FechaOperacion`: when the operation took place, if not the issue date */
  operationDate?: IsoDate
  /** `DescripcionOperacion` (1 to 500 characters) */
  description: string
  /** `FacturaSimplificadaArt7273` */
  qualifiedSimplified?: boolean
  /** `FacturaSinIdentifDestinatarioArt61d` */
  withoutRecipientArt61d?: boolean
  /** `Macrodato`: the invoice is above the threshold */
  macrodata?: boolean
  /** `EmitidaPorTerceroODestinatario` */
  issuedBy?: IssuedByOther
  /** `Tercero` */
  thirdParty?: Party
  /** `Destinatarios`: up to 1000 */
  recipients?: Party[]
  /** `Cupon` */
  coupon?: boolean
  /** `Desglose`: 1 to 12 lines */
  breakdown: BreakdownLine[]
  /** `CuotaTotal`: the sum of the tax when left out */
  totalTax?: Amount
  /** `ImporteTotal`: the sum of bases and tax when left out */
  totalAmount?: Amount
  /** `NumRegistroAcuerdoFacturacion` (at most 15 characters) */
  billingAgreementNumber?: string
  /** `IdAcuerdoSistemaInformatico` (at most 16 characters) */
  systemAgreementId?: string
  system: SoftwareSystem
  /** `FechaHoraHusoGenRegistro`: a `Date`, or an ISO 8601 text with its offset such as `2024-01-01T19:20:30+01:00` */
  generatedAt: Date | string
}

/** A breakdown line with its amounts written as AEAT wants them */
export interface NormalisedBreakdownLine {
  tax?: Tax
  regimeKey?: RegimeKey
  qualification?: OperationQualification
  exemption?: Exemption
  taxRate?: string
  taxableBase: string
  costBase?: string
  taxAmount?: string
  surchargeRate?: string
  surchargeAmount?: string
}

/** A complete *alta* record: what is sent, and what the hash covers */
export interface InvoiceRecord {
  kind: 'alta'
  id: InvoiceId
  externalRef?: string
  issuerName: string
  amendment?: boolean
  previousRejection?: PreviousRejection
  invoiceType: InvoiceType
  rectification?: RectificationType
  rectifiedInvoices?: InvoiceRef[]
  substitutedInvoices?: InvoiceRef[]
  rectifiedAmounts?: { base: string, tax: string, surcharge?: string }
  operationDate?: IsoDate
  description: string
  qualifiedSimplified?: boolean
  withoutRecipientArt61d?: boolean
  macrodata?: boolean
  issuedBy?: IssuedByOther
  thirdParty?: Party
  recipients?: Party[]
  coupon?: boolean
  breakdown: NormalisedBreakdownLine[]
  totalTax: string
  totalAmount: string
  chaining: Chaining
  system: SoftwareSystem
  generatedAt: string
  billingAgreementNumber?: string
  systemAgreementId?: string
  hashType: HashType
  /** `Huella`: 64 upper-case hexadecimal characters */
  hash: string
  /** `ds:Signature`: the XAdES signature (XML text), set by `signRecord`. Only systems that do not send records to AEAT routinely need it. */
  signature?: string
}

/** What it takes to cancel an invoice's record (*anulación*) */
export interface CancellationRecordInput {
  /** The invoice being cancelled (`IDFactura`) */
  id: InvoiceId
  externalRef?: string
  /** `SinRegistroPrevio`: AEAT never received the record of the invoice being cancelled */
  withoutPreviousRecord?: boolean
  /** `RechazoPrevio`: an earlier cancellation was rejected (`S`) or not (`N`) */
  previousRejection?: 'S' | 'N'
  /** `GeneradoPor` */
  generatedBy?: CancellationGenerator
  /** `Generador`: who generated it, when not the issuer */
  generator?: Party
  system: SoftwareSystem
  generatedAt: Date | string
}

export interface CancellationRecord {
  kind: 'anulacion'
  id: InvoiceId
  externalRef?: string
  withoutPreviousRecord?: boolean
  previousRejection?: 'S' | 'N'
  generatedBy?: CancellationGenerator
  generator?: Party
  chaining: Chaining
  system: SoftwareSystem
  generatedAt: string
  hashType: HashType
  hash: string
  /** `ds:Signature`: the XAdES signature (XML text), set by `signRecord` */
  signature?: string
}

export type BillingRecord = InvoiceRecord | CancellationRecord

/** The header of a submission (`Cabecera`) */
export interface SubmissionHeader {
  /** `ObligadoEmision`: who is obliged to issue the invoices */
  taxpayer: Taxpayer
  /** `Representante`: only when the records were generated by an adviser of the taxpayer */
  representative?: Taxpayer
  /** `RemisionVoluntaria`: for the voluntary remission service (VERI*FACTU mode) */
  voluntary?: {
    /** `FechaFinVeriFactu`: the day the taxpayer stops using VERI*FACTU mode */
    verifactuEndDate?: IsoDate
    /** `Incidencia`: the records were generated during an incident */
    incident?: boolean
  }
  /** `RemisionRequerimiento`: for records sent in answer to an AEAT requirement */
  requirement?: {
    /** `RefRequerimiento` (at most 18 characters) */
    reference: string
    /** `FinRequerimiento`: the last submission for this requirement */
    finished?: boolean
  }
}

/** How validation found fault with something */
export interface ValidationIssue {
  /** `error` is something AEAT's schema rejects; `warning` is something its business rules are likely to flag */
  severity: 'error' | 'warning'
  /** A stable code, e.g. `text-too-long` */
  code: string
  /** Where, e.g. `breakdown[1].taxRate` */
  path: string
  message: string
}

/** The part of a reply naming the operation done on a record (`Operacion`) */
export interface ReplyOperation {
  type: 'Alta' | 'Anulacion'
  amendment?: boolean
  previousRejection?: PreviousRejection
  withoutPreviousRecord?: boolean
}

/** What AEAT already holds when it rejects a record as a duplicate (`RegistroDuplicado`) */
export interface DuplicateRecord {
  /** `IdPeticionRegistroDuplicado` */
  requestId: string
  /** `EstadoRegistroDuplicado` */
  status: StoredRecordStatus
  errorCode?: number
  errorDescription?: string
}

/** AEAT's answer for one record of a submission (`RespuestaLinea`) */
export interface RecordReply {
  id: InvoiceId
  operation: ReplyOperation
  externalRef?: string
  status: RecordStatus
  errorCode?: number
  errorDescription?: string
  duplicate?: DuplicateRecord
}

/** AEAT's answer to a submission (`RespuestaRegFactuSistemaFacturacion`) */
export interface SubmissionReply {
  /** `CSV`: proof of the submission; absent when everything was rejected */
  csv?: string
  /** `DatosPresentacion` */
  presentation?: { presenterNif: string, timestamp: string }
  /** `Cabecera` as AEAT understood it */
  header: SubmissionHeader
  /** `TiempoEsperaEnvio`: seconds to wait before the next submission */
  waitSeconds: number
  /** `EstadoEnvio` */
  status: SubmissionStatus
  records: RecordReply[]
}

/** A query for records already submitted (`ConsultaFactuSistemaFacturacion`) */
export interface RecordQuery {
  /** Who is asking as the obliged taxpayer (`ObligadoEmision`); give this *or* `recipient` */
  taxpayer?: Taxpayer
  /** Who is asking as the recipient of the invoices (`Destinatario`) */
  recipient?: Taxpayer
  /** `IndicadorRepresentante`: asking as the taxpayer's adviser */
  asRepresentative?: boolean
  /** `Ejercicio` */
  year: number | string
  /** `Periodo` */
  period: Period
  /** `NumSerieFactura` */
  invoiceNumber?: string
  /** `Contraparte` */
  counterparty?: Party
  /** `FechaExpedicionFactura`: one day, or a range */
  issueDate?: IsoDate | { from?: IsoDate, to?: IsoDate }
  /** `RefExterna` */
  externalRef?: string
  /** `SistemaInformatico` filter: narrow to records of one system installation */
  system?: { producerName: string, producerNif?: string, producerOtherId?: OtherId, id: string, installationNumber: string, name?: string, version?: string }
  /** `ClavePaginacion`: where the previous page ended */
  pageKey?: InvoiceId
  /** `MostrarNombreRazonEmisor` */
  showIssuerName?: boolean
  /** `MostrarSistemaInformatico` */
  showSystem?: boolean
}

/** A stored record as AEAT returns it from a query: what it holds, which may be less than was sent */
export interface StoredRecord {
  id: InvoiceId
  data: {
    issuerName?: string
    externalRef?: string
    amendment?: boolean
    previousRejection?: PreviousRejection
    withoutPreviousRecord?: boolean
    generatedBy?: CancellationGenerator
    invoiceType?: InvoiceType
    rectification?: RectificationType
    operationDate?: IsoDate
    description?: string
    recipients?: Party[]
    breakdown?: NormalisedBreakdownLine[]
    totalTax?: string
    totalAmount?: string
    chaining?: Chaining
    system?: SoftwareSystem
    generatedAt?: string
    hashType?: HashType
    hash?: string
    representativeNif?: string
    verifactuEndDate?: IsoDate
    incident?: boolean
  }
  presentation?: { presenterNif: string, timestamp: string, requestId: string }
  state: {
    lastModified: string
    status: StoredRecordStatus
    errorCode?: number
    errorDescription?: string
  }
}

/** AEAT's answer to a query (`RespuestaConsultaFactuSistemaFacturacion`) */
export interface QueryReply {
  year: string
  period: Period
  /** `IndicadorPaginacion`: there are more records than this page holds */
  hasMore: boolean
  /** `ResultadoConsulta` */
  hasData: boolean
  records: StoredRecord[]
  /** `ClavePaginacion`: pass as `pageKey` to get the next page */
  nextPageKey?: InvoiceId
}
