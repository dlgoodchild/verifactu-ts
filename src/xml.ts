import { XMLParser } from 'fast-xml-parser'
import { RecordFormatVersion, type CancellationGenerator, type InvoiceType, type Period, type PreviousRejection, type StoredRecordStatus } from '~/codes'
import { VerifactuResponseError, VerifactuSoapFaultError } from '~/errors'
import { fromAeatDate, toAeatDate } from '~/format'
import { branch, escapeXml, insertBeforeClosing, leaf, otherIdXml as writeOtherId, partyXml as writeParty, siNo, systemXml as writeSystem } from '~/xml-write'
import type {
  BillingRecord, CancellationRecord, Chaining, InvoiceId, InvoiceRecord, NormalisedBreakdownLine, OtherId, Party, QueryReply, RecordQuery, RecordReply, SoftwareSystem,
  StoredRecord, SubmissionHeader, SubmissionReply, Taxpayer
} from '~/types'

/**
 * Building and reading the SOAP 1.1 messages (document/literal) of AEAT's VERI*FACTU web service. Elements are written
 * in exactly the order AEAT's schemas (XSD) require, since XML schemas are strict about order.
 */

export const Namespaces = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  /** SuministroLR.xsd: the submission envelope */
  submission: 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd',
  /** SuministroInformacion.xsd: the shared types, i.e. nearly all the elements */
  info: 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd',
  /** ConsultaLR.xsd: the query envelope */
  query: 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/ConsultaLR.xsd'
} as const

// ---------------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------------

export { escapeXml }

const i = (name: string) => `sum1:${name}`

const otherIdXml = (other: OtherId): string => writeOtherId(i, other)
const partyXml = (tag: string, party: Party): string => writeParty(i, tag, party)
const systemXml = (system: SoftwareSystem): string => writeSystem(i, system)

function taxpayerXml(tag: string, taxpayer: Taxpayer): string {
  return branch(tag, leaf(i('NombreRazon'), taxpayer.name), leaf(i('NIF'), taxpayer.nif))
}

function invoiceIdXml(tag: string, id: InvoiceId, names: { issuer: string, number: string, date: string }): string {
  return branch(tag, leaf(i(names.issuer), id.issuerNif), leaf(i(names.number), id.number), leaf(i(names.date), toAeatDate(id.issueDate)))
}

const invoiceRefXml = (tag: string, ref: InvoiceId) =>
  invoiceIdXml(tag, ref, { issuer: 'IDEmisorFactura', number: 'NumSerieFactura', date: 'FechaExpedicionFactura' })

function chainingXml(chaining: Chaining): string {
  if (chaining.first) {
    return branch(i('Encadenamiento'), leaf(i('PrimerRegistro'), 'S'))
  }
  const link = chaining.previous
  return branch(
    i('Encadenamiento'),
    branch(
      i('RegistroAnterior'),
      leaf(i('IDEmisorFactura'), link.issuerNif),
      leaf(i('NumSerieFactura'), link.number),
      leaf(i('FechaExpedicionFactura'), toAeatDate(link.issueDate)),
      leaf(i('Huella'), link.hash)
    )
  )
}

function breakdownLineXml(line: NormalisedBreakdownLine): string {
  return branch(
    i('DetalleDesglose'),
    leaf(i('Impuesto'), line.tax),
    leaf(i('ClaveRegimen'), line.regimeKey),
    line.qualification ? leaf(i('CalificacionOperacion'), line.qualification) : leaf(i('OperacionExenta'), line.exemption),
    leaf(i('TipoImpositivo'), line.taxRate),
    leaf(i('BaseImponibleOimporteNoSujeto'), line.taxableBase),
    leaf(i('BaseImponibleACoste'), line.costBase),
    leaf(i('CuotaRepercutida'), line.taxAmount),
    leaf(i('TipoRecargoEquivalencia'), line.surchargeRate),
    leaf(i('CuotaRecargoEquivalencia'), line.surchargeAmount)
  )
}

export interface RecordXmlOptions {
  /** Declare the namespace on the record element itself so it stands alone: this is the form that gets signed */
  standalone?: boolean
  /** Leave out the record's signature, if it has one */
  unsigned?: boolean
}

/** Adds the signature and, if asked, the namespace declaration, to a record's XML */
function finishRecord(xml: string, tag: string, signature: string | undefined, options: RecordXmlOptions): string {
  const signed = signature && !options.unsigned ? insertBeforeClosing(xml, `</${tag}>`, signature) : xml
  return options.standalone ? signed.replace(`<${tag}>`, `<${tag} xmlns:sum1="${Namespaces.info}">`) : signed
}

/** The XML of an *alta* record (`RegistroAlta`), with its signature if it has one */
export function invoiceRecordXml(record: InvoiceRecord, options: RecordXmlOptions = {}): string {
  return finishRecord(buildInvoiceRecord(record), i('RegistroAlta'), record.signature, options)
}

function buildInvoiceRecord(record: InvoiceRecord): string {
  return branch(
    i('RegistroAlta'),
    leaf(i('IDVersion'), RecordFormatVersion),
    invoiceRefXml(i('IDFactura'), record.id),
    leaf(i('RefExterna'), record.externalRef),
    leaf(i('NombreRazonEmisor'), record.issuerName),
    leaf(i('Subsanacion'), siNo(record.amendment)),
    leaf(i('RechazoPrevio'), record.previousRejection),
    leaf(i('TipoFactura'), record.invoiceType),
    leaf(i('TipoRectificativa'), record.rectification),
    record.rectifiedInvoices?.length ? branch(i('FacturasRectificadas'), ...record.rectifiedInvoices.map((ref) => invoiceRefXml(i('IDFacturaRectificada'), ref))) : '',
    record.substitutedInvoices?.length ? branch(i('FacturasSustituidas'), ...record.substitutedInvoices.map((ref) => invoiceRefXml(i('IDFacturaSustituida'), ref))) : '',
    record.rectifiedAmounts
      ? branch(i('ImporteRectificacion'), leaf(i('BaseRectificada'), record.rectifiedAmounts.base), leaf(i('CuotaRectificada'), record.rectifiedAmounts.tax), leaf(i('CuotaRecargoRectificado'), record.rectifiedAmounts.surcharge))
      : '',
    record.operationDate ? leaf(i('FechaOperacion'), toAeatDate(record.operationDate)) : '',
    leaf(i('DescripcionOperacion'), record.description),
    leaf(i('FacturaSimplificadaArt7273'), siNo(record.qualifiedSimplified)),
    leaf(i('FacturaSinIdentifDestinatarioArt61d'), siNo(record.withoutRecipientArt61d)),
    leaf(i('Macrodato'), siNo(record.macrodata)),
    leaf(i('EmitidaPorTerceroODestinatario'), record.issuedBy),
    record.thirdParty ? partyXml(i('Tercero'), record.thirdParty) : '',
    record.recipients?.length ? branch(i('Destinatarios'), ...record.recipients.map((party) => partyXml(i('IDDestinatario'), party))) : '',
    leaf(i('Cupon'), siNo(record.coupon)),
    branch(i('Desglose'), ...record.breakdown.map(breakdownLineXml)),
    leaf(i('CuotaTotal'), record.totalTax),
    leaf(i('ImporteTotal'), record.totalAmount),
    chainingXml(record.chaining),
    systemXml(record.system),
    leaf(i('FechaHoraHusoGenRegistro'), record.generatedAt),
    leaf(i('NumRegistroAcuerdoFacturacion'), record.billingAgreementNumber),
    leaf(i('IdAcuerdoSistemaInformatico'), record.systemAgreementId),
    leaf(i('TipoHuella'), record.hashType),
    leaf(i('Huella'), record.hash)
  )
}

/** The XML of a cancellation record (`RegistroAnulacion`), with its signature if it has one */
export function cancellationRecordXml(record: CancellationRecord, options: RecordXmlOptions = {}): string {
  return finishRecord(buildCancellationRecord(record), i('RegistroAnulacion'), record.signature, options)
}

function buildCancellationRecord(record: CancellationRecord): string {
  return branch(
    i('RegistroAnulacion'),
    leaf(i('IDVersion'), RecordFormatVersion),
    invoiceIdXml(i('IDFactura'), record.id, { issuer: 'IDEmisorFacturaAnulada', number: 'NumSerieFacturaAnulada', date: 'FechaExpedicionFacturaAnulada' }),
    leaf(i('RefExterna'), record.externalRef),
    leaf(i('SinRegistroPrevio'), siNo(record.withoutPreviousRecord)),
    leaf(i('RechazoPrevio'), record.previousRejection),
    leaf(i('GeneradoPor'), record.generatedBy),
    record.generator ? partyXml(i('Generador'), record.generator) : '',
    chainingXml(record.chaining),
    systemXml(record.system),
    leaf(i('FechaHoraHusoGenRegistro'), record.generatedAt),
    leaf(i('TipoHuella'), record.hashType),
    leaf(i('Huella'), record.hash)
  )
}

const recordXml = (record: BillingRecord): string => (record.kind === 'alta' ? invoiceRecordXml(record) : cancellationRecordXml(record))

function headerXml(header: SubmissionHeader): string {
  return branch(
    'sum:Cabecera',
    taxpayerXml(i('ObligadoEmision'), header.taxpayer),
    header.representative ? taxpayerXml(i('Representante'), header.representative) : '',
    header.voluntary
      ? branch(
        i('RemisionVoluntaria'),
        header.voluntary.verifactuEndDate ? leaf(i('FechaFinVeriFactu'), toAeatDate(header.voluntary.verifactuEndDate)) : '',
        leaf(i('Incidencia'), siNo(header.voluntary.incident))
      )
      : '',
    header.requirement
      ? branch(i('RemisionRequerimiento'), leaf(i('RefRequerimiento'), header.requirement.reference), leaf(i('FinRequerimiento'), siNo(header.requirement.finished)))
      : ''
  )
}

const envelope = (namespaces: string, body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${Namespaces.soap}" ${namespaces}><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`

/** The SOAP message that submits records (`RegFactuSistemaFacturacion`) */
export function buildSubmissionXml(header: SubmissionHeader, records: BillingRecord[]): string {
  const body = `<sum:RegFactuSistemaFacturacion>${headerXml(header)}${records.map((record) => `<sum:RegistroFactura>${recordXml(record)}</sum:RegistroFactura>`).join('')}</sum:RegFactuSistemaFacturacion>`
  return envelope(`xmlns:sum="${Namespaces.submission}" xmlns:sum1="${Namespaces.info}"`, body)
}

const q = (name: string) => `con:${name}`

/** The SOAP message that queries submitted records (`ConsultaFactuSistemaFacturacion`) */
export function buildQueryXml(query: RecordQuery): string {
  if (!!query.taxpayer === !!query.recipient) {
    throw new RangeError('A query needs exactly one of `taxpayer` (asking as the issuer) or `recipient` (asking as the customer)')
  }

  const header = branch(
    q('Cabecera'),
    leaf(i('IDVersion'), RecordFormatVersion),
    query.taxpayer ? taxpayerXml(i('ObligadoEmision'), query.taxpayer) : taxpayerXml(i('Destinatario'), query.recipient!),
    query.asRepresentative ? leaf(i('IndicadorRepresentante'), 'S') : ''
  )

  const date = query.issueDate
  const dateXml = date === undefined
    ? ''
    : branch(
      q('FechaExpedicionFactura'),
      typeof date === 'string'
        ? leaf(i('FechaExpedicionFactura'), toAeatDate(date))
        : branch(i('RangoFechaExpedicion'), date.from ? leaf(i('Desde'), toAeatDate(date.from)) : '', date.to ? leaf(i('Hasta'), toAeatDate(date.to)) : '')
    )

  const system = query.system
  const systemFilter = system
    ? branch(
      q('SistemaInformatico'),
      leaf(i('NombreRazon'), system.producerName),
      system.producerNif !== undefined ? leaf(i('NIF'), system.producerNif) : system.producerOtherId ? otherIdXml(system.producerOtherId) : '',
      leaf(i('NombreSistemaInformatico'), system.name),
      leaf(i('IdSistemaInformatico'), system.id),
      leaf(i('Version'), system.version),
      leaf(i('NumeroInstalacion'), system.installationNumber)
    )
    : ''

  const filter = branch(
    q('FiltroConsulta'),
    branch(q('PeriodoImputacion'), leaf(i('Ejercicio'), String(query.year)), leaf(i('Periodo'), query.period)),
    leaf(q('NumSerieFactura'), query.invoiceNumber),
    query.counterparty ? partyXml(q('Contraparte'), query.counterparty) : '',
    dateXml,
    systemFilter,
    leaf(q('RefExterna'), query.externalRef),
    query.pageKey ? invoiceRefXml(q('ClavePaginacion'), query.pageKey) : ''
  )

  const extra = branch(q('DatosAdicionalesRespuesta'), leaf(q('MostrarNombreRazonEmisor'), siNo(query.showIssuerName)), leaf(q('MostrarSistemaInformatico'), siNo(query.showSystem)))

  return envelope(`xmlns:con="${Namespaces.query}" xmlns:sum1="${Namespaces.info}"`, `<con:ConsultaFactuSistemaFacturacion>${header}${filter}${extra}</con:ConsultaFactuSistemaFacturacion>`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------------

// A loose view of the parsed XML, which is read field by field and so cannot be typed in advance
type Node = Record<string, unknown>

/** Elements that repeat, so are always read as a list even when there is only one */
const ListElements = new Set([
  'RespuestaLinea', 'RegistroRespuestaConsultaFactuSistemaFacturacion', 'IDDestinatario', 'DetalleDesglose', 'IDFacturaRectificada', 'IDFacturaSustituida'
])

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ListElements.has(name)
})

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)
const node = (value: unknown): Node | undefined => (isNode(value) ? value : undefined)
const list = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [])
const str = (value: unknown): string | undefined => (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined)
const int = (value: unknown): number | undefined => { const text = str(value); return text !== undefined && /^-?\d+$/.test(text) ? Number(text) : undefined }
const flag = (value: unknown): boolean | undefined => (value === 'S' ? true : value === 'N' ? false : undefined)
const date = (value: unknown): string | undefined => { const text = str(value); return text === undefined ? undefined : /^\d{2}-\d{2}-\d{4}$/.test(text) ? fromAeatDate(text) : text }

function parseDocument(xml: string): { body: Node } {
  let document: Node
  try {
    document = parser.parse(xml) as Node
  }
  catch (error) {
    throw new VerifactuResponseError(`The reply is not valid XML: ${(error as Error).message}`, undefined, xml)
  }
  const body = node(node(document.Envelope)?.Body)
  if (!body) {
    throw new VerifactuResponseError('The reply is not a SOAP message (no Envelope/Body)', undefined, xml)
  }
  return { body }
}

/** The fault a SOAP message carries, as an error; null if it holds none */
export function parseSoapFault(xml: string, httpStatus?: number): VerifactuSoapFaultError | null {
  let body: Node
  try {
    body = parseDocument(xml).body
  }
  catch {
    return null
  }
  const fault = node(body.Fault)
  if (!fault) return null

  const faultCode = str(fault.faultcode) ?? 'unknown'
  const faultString = str(fault.faultstring) ?? ''
  const aeatCode = /Codigo\[(\d+)\]/.exec(faultString)?.[1]
  // A `Client` fault says the message is wrong; anything else is on AEAT's side, so the same message may be sent again
  return new VerifactuSoapFaultError(faultCode, faultString, aeatCode ? Number(aeatCode) : null, !/Client$/i.test(faultCode), httpStatus)
}

const invoiceIdOf = (value: unknown): InvoiceId => {
  const id = node(value) ?? {}
  return { issuerNif: str(id.IDEmisorFactura) ?? '', number: str(id.NumSerieFactura) ?? '', issueDate: date(id.FechaExpedicionFactura) ?? '' }
}

const taxpayerOf = (value: unknown): Taxpayer | undefined => {
  const entry = node(value)
  return entry ? { name: str(entry.NombreRazon) ?? '', nif: str(entry.NIF) ?? '' } : undefined
}

const otherIdOf = (value: unknown): OtherId | undefined => {
  const other = node(value)
  return other ? { ...(str(other.CodigoPais) ? { countryCode: str(other.CodigoPais) } : {}), type: str(other.IDType) as OtherId['type'], id: str(other.ID) ?? '' } : undefined
}

const partyOf = (value: unknown): Party => {
  const entry = node(value) ?? {}
  return { name: str(entry.NombreRazon) ?? '', ...(str(entry.NIF) ? { nif: str(entry.NIF) } : {}), ...(entry.IDOtro ? { otherId: otherIdOf(entry.IDOtro) } : {}) }
}

function headerOf(value: unknown): SubmissionHeader {
  const header = node(value) ?? {}
  const voluntary = node(header.RemisionVoluntaria)
  const requirement = node(header.RemisionRequerimiento)
  return {
    taxpayer: taxpayerOf(header.ObligadoEmision) ?? { name: '', nif: '' },
    ...(header.Representante ? { representative: taxpayerOf(header.Representante) } : {}),
    ...(voluntary ? { voluntary: { ...(voluntary.FechaFinVeriFactu ? { verifactuEndDate: date(voluntary.FechaFinVeriFactu) } : {}), ...(voluntary.Incidencia ? { incident: flag(voluntary.Incidencia) } : {}) } } : {}),
    ...(requirement ? { requirement: { reference: str(requirement.RefRequerimiento) ?? '', ...(requirement.FinRequerimiento ? { finished: flag(requirement.FinRequerimiento) } : {}) } } : {})
  }
}

function recordReplyOf(entry: Node): RecordReply {
  const operation = node(entry.Operacion) ?? {}
  const duplicate = node(entry.RegistroDuplicado)
  return {
    id: invoiceIdOf(entry.IDFactura),
    operation: {
      type: (str(operation.TipoOperacion) as 'Alta' | 'Anulacion') ?? 'Alta',
      ...(operation.Subsanacion ? { amendment: flag(operation.Subsanacion) } : {}),
      ...(operation.RechazoPrevio ? { previousRejection: str(operation.RechazoPrevio) as PreviousRejection } : {}),
      ...(operation.SinRegistroPrevio ? { withoutPreviousRecord: flag(operation.SinRegistroPrevio) } : {})
    },
    ...(str(entry.RefExterna) ? { externalRef: str(entry.RefExterna) } : {}),
    status: str(entry.EstadoRegistro) as RecordReply['status'],
    ...(int(entry.CodigoErrorRegistro) !== undefined ? { errorCode: int(entry.CodigoErrorRegistro) } : {}),
    ...(str(entry.DescripcionErrorRegistro) ? { errorDescription: str(entry.DescripcionErrorRegistro) } : {}),
    ...(duplicate
      ? {
        duplicate: {
          requestId: str(duplicate.IdPeticionRegistroDuplicado) ?? '',
          status: str(duplicate.EstadoRegistroDuplicado) as StoredRecordStatus,
          ...(int(duplicate.CodigoErrorRegistro) !== undefined ? { errorCode: int(duplicate.CodigoErrorRegistro) } : {}),
          ...(str(duplicate.DescripcionErrorRegistro) ? { errorDescription: str(duplicate.DescripcionErrorRegistro) } : {})
        }
      }
      : {})
  }
}

/** Reads AEAT's answer to a submission. Throws `VerifactuSoapFaultError` for a fault and `VerifactuResponseError` for anything unexpected. */
export function parseSubmissionReply(xml: string, httpStatus?: number): SubmissionReply {
  const fault = parseSoapFault(xml, httpStatus)
  if (fault) throw fault

  const { body } = parseDocument(xml)
  const reply = node(body.RespuestaRegFactuSistemaFacturacion)
  if (!reply) {
    throw new VerifactuResponseError('The reply does not hold a submission result (RespuestaRegFactuSistemaFacturacion)', httpStatus, xml)
  }

  const presentation = node(reply.DatosPresentacion)
  const waitSeconds = int(reply.TiempoEsperaEnvio)
  const status = str(reply.EstadoEnvio) as SubmissionReply['status']
  if (waitSeconds === undefined || !status) {
    throw new VerifactuResponseError('The submission result is missing its status or wait time', httpStatus, xml)
  }

  return {
    ...(str(reply.CSV) ? { csv: str(reply.CSV) } : {}),
    ...(presentation ? { presentation: { presenterNif: str(presentation.NIFPresentador) ?? '', timestamp: str(presentation.TimestampPresentacion) ?? '' } } : {}),
    header: headerOf(reply.Cabecera),
    waitSeconds,
    status,
    records: list(reply.RespuestaLinea).map(recordReplyOf)
  }
}

function breakdownOf(value: unknown): NormalisedBreakdownLine[] {
  return list(node(value)?.DetalleDesglose).map((line) => ({
    ...(str(line.Impuesto) ? { tax: str(line.Impuesto) as NormalisedBreakdownLine['tax'] } : {}),
    ...(str(line.ClaveRegimen) ? { regimeKey: str(line.ClaveRegimen) as NormalisedBreakdownLine['regimeKey'] } : {}),
    ...(str(line.CalificacionOperacion) ? { qualification: str(line.CalificacionOperacion) as NormalisedBreakdownLine['qualification'] } : {}),
    ...(str(line.OperacionExenta) ? { exemption: str(line.OperacionExenta) as NormalisedBreakdownLine['exemption'] } : {}),
    ...(str(line.TipoImpositivo) ? { taxRate: str(line.TipoImpositivo) } : {}),
    taxableBase: str(line.BaseImponibleOimporteNoSujeto) ?? '',
    ...(str(line.BaseImponibleACoste) ? { costBase: str(line.BaseImponibleACoste) } : {}),
    ...(str(line.CuotaRepercutida) ? { taxAmount: str(line.CuotaRepercutida) } : {}),
    ...(str(line.TipoRecargoEquivalencia) ? { surchargeRate: str(line.TipoRecargoEquivalencia) } : {}),
    ...(str(line.CuotaRecargoEquivalencia) ? { surchargeAmount: str(line.CuotaRecargoEquivalencia) } : {})
  }))
}

function chainingOf(value: unknown): Chaining | undefined {
  const chaining = node(value)
  if (!chaining) return undefined
  if (chaining.PrimerRegistro) return { first: true }
  const previous = node(chaining.RegistroAnterior)
  return previous ? { previous: { ...invoiceIdOf(previous), hash: str(previous.Huella) ?? '' } } : undefined
}

function systemOf(value: unknown): SoftwareSystem | undefined {
  const system = node(value)
  if (!system) return undefined
  return {
    producerName: str(system.NombreRazon) ?? '',
    ...(str(system.NIF) ? { producerNif: str(system.NIF) } : {}),
    ...(system.IDOtro ? { producerOtherId: otherIdOf(system.IDOtro) } : {}),
    name: str(system.NombreSistemaInformatico) ?? '',
    id: str(system.IdSistemaInformatico) ?? '',
    version: str(system.Version) ?? '',
    installationNumber: str(system.NumeroInstalacion) ?? '',
    onlyVerifactu: flag(system.TipoUsoPosibleSoloVerifactu) ?? false,
    multiTaxpayer: flag(system.TipoUsoPosibleMultiOT) ?? false,
    multipleTaxpayersInUse: flag(system.IndicadorMultiplesOT) ?? false
  }
}

function storedRecordOf(entry: Node): StoredRecord {
  const data = node(entry.DatosRegistroFacturacion) ?? {}
  const presentation = node(entry.DatosPresentacion)
  const state = node(entry.EstadoRegistro) ?? {}
  const recipients = list(node(data.Destinatarios)?.IDDestinatario).map(partyOf)
  const chaining = chainingOf(data.Encadenamiento)
  const system = systemOf(data.SistemaInformatico)

  return {
    id: invoiceIdOf(entry.IDFactura),
    data: {
      ...(str(data.NombreRazonEmisor) ? { issuerName: str(data.NombreRazonEmisor) } : {}),
      ...(str(data.RefExterna) ? { externalRef: str(data.RefExterna) } : {}),
      ...(data.Subsanacion ? { amendment: flag(data.Subsanacion) } : {}),
      ...(data.RechazoPrevio ? { previousRejection: str(data.RechazoPrevio) as PreviousRejection } : {}),
      ...(data.SinRegistroPrevio ? { withoutPreviousRecord: flag(data.SinRegistroPrevio) } : {}),
      ...(data.GeneradoPor ? { generatedBy: str(data.GeneradoPor) as CancellationGenerator } : {}),
      ...(str(data.TipoFactura) ? { invoiceType: str(data.TipoFactura) as InvoiceType } : {}),
      ...(str(data.TipoRectificativa) ? { rectification: str(data.TipoRectificativa) as StoredRecord['data']['rectification'] } : {}),
      ...(str(data.FechaOperacion) ? { operationDate: date(data.FechaOperacion) } : {}),
      ...(str(data.DescripcionOperacion) ? { description: str(data.DescripcionOperacion) } : {}),
      ...(recipients.length > 0 ? { recipients } : {}),
      ...(data.Desglose ? { breakdown: breakdownOf(data.Desglose) } : {}),
      ...(str(data.CuotaTotal) ? { totalTax: str(data.CuotaTotal) } : {}),
      ...(str(data.ImporteTotal) ? { totalAmount: str(data.ImporteTotal) } : {}),
      ...(chaining ? { chaining } : {}),
      ...(system ? { system } : {}),
      ...(str(data.FechaHoraHusoGenRegistro) ? { generatedAt: str(data.FechaHoraHusoGenRegistro) } : {}),
      ...(str(data.TipoHuella) ? { hashType: str(data.TipoHuella) as StoredRecord['data']['hashType'] } : {}),
      ...(str(data.Huella) ? { hash: str(data.Huella) } : {}),
      ...(str(data.NifRepresentante) ? { representativeNif: str(data.NifRepresentante) } : {}),
      ...(str(data.FechaFinVeriFactu) ? { verifactuEndDate: date(data.FechaFinVeriFactu) } : {}),
      ...(data.Incidencia ? { incident: flag(data.Incidencia) } : {})
    },
    ...(presentation ? { presentation: { presenterNif: str(presentation.NIFPresentador) ?? '', timestamp: str(presentation.TimestampPresentacion) ?? '', requestId: str(presentation.IdPeticion) ?? '' } } : {}),
    state: {
      lastModified: str(state.TimestampUltimaModificacion) ?? '',
      status: str(state.EstadoRegistro) as StoredRecordStatus,
      ...(int(state.CodigoErrorRegistro) !== undefined ? { errorCode: int(state.CodigoErrorRegistro) } : {}),
      ...(str(state.DescripcionErrorRegistro) ? { errorDescription: str(state.DescripcionErrorRegistro) } : {})
    }
  }
}

/** Reads AEAT's answer to a query. Throws `VerifactuSoapFaultError` for a fault and `VerifactuResponseError` for anything unexpected. */
export function parseQueryReply(xml: string, httpStatus?: number): QueryReply {
  const fault = parseSoapFault(xml, httpStatus)
  if (fault) throw fault

  const { body } = parseDocument(xml)
  const reply = node(body.RespuestaConsultaFactuSistemaFacturacion)
  if (!reply) {
    throw new VerifactuResponseError('The reply does not hold a query result (RespuestaConsultaFactuSistemaFacturacion)', httpStatus, xml)
  }

  const period = node(reply.PeriodoImputacion) ?? {}
  const nextKey = node(reply.ClavePaginacion)
  return {
    year: str(period.Ejercicio) ?? '',
    period: (str(period.Periodo) ?? '') as Period,
    hasMore: flag(reply.IndicadorPaginacion) ?? false,
    hasData: str(reply.ResultadoConsulta) === 'ConDatos',
    records: list(reply.RegistroRespuestaConsultaFactuSistemaFacturacion).map(storedRecordOf),
    ...(nextKey ? { nextPageKey: invoiceIdOf(nextKey) } : {})
  }
}
