import { RecordFormatVersion } from '~/codes'
import type { AnomalyChecks, EventData, EventLink, EventRecord } from '~/events'
import { toAeatDate } from '~/format'
import type { ChainLink, InvoiceId } from '~/types'
import { branch, insertBeforeClosing, leaf, partyXml, siNo, systemXml } from '~/xml-write'

/**
 * The XML of an event record (`RegistroEvento`, schema `EventosSIF.xsd`), with its elements in the order the schema
 * requires. Unlike billing records, event records are not sent in AEAT's web service: they are kept, and handed over
 * (exported) when AEAT asks.
 */

export const EventNamespace = 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/EventosSIF.xsd'

const s = (name: string) => `sf:${name}`

const yesNo = (performed: boolean) => siNo(performed)

/** The checks of events 03 and 05; billing records and event records name the same four checks differently */
function checksXml(checks: AnomalyChecks, forEvents: boolean): string {
  const entries: Array<[string, AnomalyChecks['hashes']]> = [
    ['IntegridadHuellas', checks.hashes], ['IntegridadFirmas', checks.signatures], ['TrazabilidadCadena', checks.chain], ['TrazabilidadFechas', checks.dates]
  ]
  return entries.map(([what, run]) =>
    leaf(s(`RealizadoProcesoSobre${what}${forEvents ? 'RegEvento' : 'RegFacturacion'}`), yesNo(run.performed))
    + leaf(s(`NumeroDeRegistros${forEvents ? 'Evento' : 'Facturacion'}ProcesadosSobre${what}`), run.processed)
  ).join('')
}

const billingRefXml = (tag: string, ref: InvoiceId | ChainLink): string =>
  branch(
    s(tag),
    leaf(s('IDEmisorFactura'), ref.issuerNif),
    leaf(s('NumSerieFactura'), ref.number),
    leaf(s('FechaExpedicionFactura'), toAeatDate(ref.issueDate)),
    'hash' in ref ? leaf(s('Huella'), ref.hash) : ''
  )

const eventRefXml = (tag: string, link: EventLink): string =>
  branch(s(tag), leaf(s('TipoEvento'), link.type), leaf(s('FechaHoraHusoEvento'), link.generatedAt), leaf(s('HuellaEvento'), link.hash))

function dataXml(data: EventData): string {
  switch (data.kind) {
    case 'billing-anomaly-check':
      return branch(s('LanzamientoProcesoDeteccionAnomaliasRegFacturacion'), checksXml(data, false))
    case 'event-anomaly-check':
      return branch(s('LanzamientoProcesoDeteccionAnomaliasRegEvento'), checksXml(data, true))
    case 'billing-anomaly':
      return branch(
        s('DeteccionAnomaliasRegFacturacion'),
        leaf(s('TipoAnomalia'), data.anomaly),
        leaf(s('OtrosDatosAnomalia'), data.details),
        data.record ? billingRefXml('RegistroFacturacionAnomalo', data.record) : ''
      )
    case 'event-anomaly':
      return branch(
        s('DeteccionAnomaliasRegEvento'),
        leaf(s('TipoAnomalia'), data.anomaly),
        leaf(s('OtrosDatosAnomalia'), data.details),
        data.event ? eventRefXml('RegEventoAnomalo', data.event) : ''
      )
    case 'billing-export':
      return branch(
        s('ExportacionRegFacturacionPeriodo'),
        leaf(s('FechaHoraHusoInicioPeriodoExport'), String(data.periodStart)),
        leaf(s('FechaHoraHusoFinPeriodoExport'), String(data.periodEnd)),
        billingRefXml('RegistroFacturacionInicialPeriodo', data.first),
        billingRefXml('RegistroFacturacionFinalPeriodo', data.last),
        leaf(s('NumeroDeRegistrosFacturacionAltaExportados'), data.altaCount),
        leaf(s('SumaCuotaTotalAlta'), data.totalTax),
        leaf(s('SumaImporteTotalAlta'), data.totalAmount),
        leaf(s('NumeroDeRegistrosFacturacionAnulacionExportados'), data.cancellationCount),
        leaf(s('RegistrosFacturacionExportadosDejanDeConservarse'), yesNo(data.noLongerKept))
      )
    case 'event-export':
      return branch(
        s('ExportacionRegEventoPeriodo'),
        leaf(s('FechaHoraHusoInicioPeriodoExport'), String(data.periodStart)),
        leaf(s('FechaHoraHusoFinPeriodoExport'), String(data.periodEnd)),
        eventRefXml('RegistroEventoInicialPeriodo', data.first),
        eventRefXml('RegistroEventoFinalPeriodo', data.last),
        leaf(s('NumeroDeRegEventoExportados'), data.count),
        leaf(s('RegEventoExportadosDejanDeConservarse'), yesNo(data.noLongerKept))
      )
    case 'summary':
      return branch(
        s('ResumenEventos'),
        ...data.counts.map((entry) => branch(s('TipoEvento'), leaf(s('TipoEvento'), entry.type), leaf(s('NumeroDeEventos'), entry.count))),
        data.firstBilling ? billingRefXml('RegistroFacturacionInicialPeriodo', data.firstBilling) : '',
        data.lastBilling ? billingRefXml('RegistroFacturacionFinalPeriodo', data.lastBilling) : '',
        leaf(s('NumeroDeRegistrosFacturacionAltaGenerados'), data.altaCount),
        leaf(s('SumaCuotaTotalAlta'), data.totalTax),
        leaf(s('SumaImporteTotalAlta'), data.totalAmount),
        leaf(s('NumeroDeRegistrosFacturacionAnulacionGenerados'), data.cancellationCount)
      )
  }
}

export interface EventXmlOptions {
  /** Leave out the record's signature, if it has one */
  unsigned?: boolean
}

/** The XML of an event record, as a standalone document (the namespace is declared on `RegistroEvento`) */
export function eventRecordXml(record: EventRecord, options: EventXmlOptions = {}): string {
  const chaining = record.chaining.first
    ? branch(s('Encadenamiento'), leaf(s('PrimerEvento'), 'S'))
    : branch(
      s('Encadenamiento'),
      branch(s('EventoAnterior'), leaf(s('TipoEvento'), record.chaining.previous!.type), leaf(s('FechaHoraHusoGenEvento'), record.chaining.previous!.generatedAt), leaf(s('HuellaEvento'), record.chaining.previous!.hash))
    )

  const xml = branch(
    s('RegistroEvento'),
    leaf(s('IDVersion'), RecordFormatVersion),
    branch(
      s('Evento'),
      systemXml(s, record.system),
      branch(s('ObligadoEmision'), leaf(s('NombreRazon'), record.taxpayer.name), leaf(s('NIF'), record.taxpayer.nif)),
      leaf(s('EmitidaPorTerceroODestinatario'), record.issuedBy),
      record.thirdParty ? partyXml(s, s('TerceroODestinatario'), record.thirdParty) : '',
      leaf(s('FechaHoraHusoGenEvento'), record.generatedAt),
      leaf(s('TipoEvento'), record.type),
      record.data ? branch(s('DatosPropiosEvento'), dataXml(record.data)) : '',
      leaf(s('OtrosDatosEvento'), record.otherData),
      chaining,
      leaf(s('TipoHuella'), record.hashType),
      leaf(s('HuellaEvento'), record.hash)
    )
  )

  const signed = record.signature && !options.unsigned ? insertBeforeClosing(xml, '</sf:Evento>', record.signature) : xml
  return signed.replace('<sf:RegistroEvento>', `<sf:RegistroEvento xmlns:sf="${EventNamespace}">`)
}
