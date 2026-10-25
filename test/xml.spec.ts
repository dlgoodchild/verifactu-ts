import { XMLParser } from 'fast-xml-parser'
import { VerifactuResponseError, VerifactuSoapFaultError } from '~/errors'
import { chainLinkOf } from '~/hash'
import { createCancellationRecord, createInvoiceRecord } from '~/record'
import { buildQueryXml, buildSubmissionXml, escapeXml, Namespaces, parseQueryReply, parseSoapFault, parseSubmissionReply } from '~/xml'
import { AeatExamples, cancellationInput, faultXml, header, invoiceInput, IssuerNif, replyLine, submissionReplyXml, system } from '@/helper/verifactu.helper'

/** Reads XML keeping the order of the elements, which is what AEAT's schema is strict about */
const ordered = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, preserveOrder: true, parseTagValue: false })

type OrderedNode = Record<string, OrderedNode[] | string>

function childNames(xml: string, path: string[]): string[] {
  let level = ordered.parse(xml) as OrderedNode[]
  for (const name of path) {
    const found = level.find((entry) => name in entry)
    if (!found) throw new Error(`No <${name}> in ${path.join('/')}`)
    level = found[name] as OrderedNode[]
  }
  return level.map((entry) => Object.keys(entry).find((key) => key !== ':@')!).filter((name) => name !== '#text')
}

const first = () => createInvoiceRecord(invoiceInput())

/** The order of elements in RegistroFacturacionAltaType of SuministroInformacion.xsd */
const AltaOrder = [
  'IDVersion', 'IDFactura', 'RefExterna', 'NombreRazonEmisor', 'Subsanacion', 'RechazoPrevio', 'TipoFactura', 'TipoRectificativa', 'FacturasRectificadas', 'FacturasSustituidas',
  'ImporteRectificacion', 'FechaOperacion', 'DescripcionOperacion', 'FacturaSimplificadaArt7273', 'FacturaSinIdentifDestinatarioArt61d', 'Macrodato', 'EmitidaPorTerceroODestinatario',
  'Tercero', 'Destinatarios', 'Cupon', 'Desglose', 'CuotaTotal', 'ImporteTotal', 'Encadenamiento', 'SistemaInformatico', 'FechaHoraHusoGenRegistro', 'NumRegistroAcuerdoFacturacion',
  'IdAcuerdoSistemaInformatico', 'TipoHuella', 'Huella'
]
const AnulacionOrder = ['IDVersion', 'IDFactura', 'RefExterna', 'SinRegistroPrevio', 'RechazoPrevio', 'GeneradoPor', 'Generador', 'Encadenamiento', 'SistemaInformatico', 'FechaHoraHusoGenRegistro', 'TipoHuella', 'Huella']

const inOrder = (actual: string[], schemaOrder: string[]) => {
  const positions = actual.map((name) => schemaOrder.indexOf(name))
  return positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1])
}

describe('escapeXml', () => {
  test('escapes the five special characters', () => {
    expect(escapeXml(`Tom & "Jerry" <b>'x'</b>`)).toBe('Tom &amp; &quot;Jerry&quot; &lt;b&gt;&apos;x&apos;&lt;/b&gt;')
  })

  test('removes the characters XML cannot hold at all', () => {
    expect(escapeXml('a\u0000b\u0008c\u000Bd\u001Fe')).toBe('abcde')
    expect(escapeXml('tab\tnewline\ncarriage\r')).toBe('tab\tnewline\ncarriage\r')
  })
})

describe('buildSubmissionXml', () => {
  test('is a SOAP 1.1 envelope in the namespaces AEAT\'s examples use', () => {
    const xml = buildSubmissionXml(header, [first()])

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope')).toBe(true)
    expect(xml).toContain(`xmlns:soapenv="${Namespaces.soap}"`)
    expect(xml).toContain(`xmlns:sum="${Namespaces.submission}"`)
    expect(xml).toContain(`xmlns:sum1="${Namespaces.info}"`)
    expect(childNames(xml, ['Envelope'])).toEqual(['Header', 'Body'])
    expect(childNames(xml, ['Envelope', 'Body'])).toEqual(['RegFactuSistemaFacturacion'])
    expect(childNames(xml, ['Envelope', 'Body', 'RegFactuSistemaFacturacion'])).toEqual(['Cabecera', 'RegistroFactura'])
  })

  test('writes the header with the taxpayer, then the optional parts in order', () => {
    const xml = buildSubmissionXml({
      taxpayer: { name: 'Dave', nif: IssuerNif },
      representative: { name: 'Gestoría', nif: 'B12345674' },
      voluntary: { verifactuEndDate: '2027-12-31', incident: true }
    }, [first()])

    expect(childNames(xml, ['Envelope', 'Body', 'RegFactuSistemaFacturacion', 'Cabecera'])).toEqual(['ObligadoEmision', 'Representante', 'RemisionVoluntaria'])
    expect(xml).toContain('<sum1:FechaFinVeriFactu>31-12-2027</sum1:FechaFinVeriFactu><sum1:Incidencia>S</sum1:Incidencia>')
  })

  test('writes a requirement header', () => {
    const xml = buildSubmissionXml({ taxpayer: header.taxpayer, requirement: { reference: 'REQ-1', finished: false } }, [first()])

    expect(xml).toContain('<sum1:RemisionRequerimiento><sum1:RefRequerimiento>REQ-1</sum1:RefRequerimiento><sum1:FinRequerimiento>N</sum1:FinRequerimiento></sum1:RemisionRequerimiento>')
  })

  test('writes an alta record with its elements in the order of the schema', () => {
    const record = createInvoiceRecord(invoiceInput({
      externalRef: 'ref', amendment: true, previousRejection: 'X', invoiceType: 'R1', rectification: 'S',
      rectifiedInvoices: [{ issuerNif: IssuerNif, number: '1', issueDate: '2023-12-01' }], substitutedInvoices: [{ issuerNif: IssuerNif, number: '2', issueDate: '2023-12-02' }],
      rectifiedAmounts: { base: 1, tax: 0.21, surcharge: 0 }, operationDate: '2023-12-31', qualifiedSimplified: false, withoutRecipientArt61d: false, macrodata: false,
      issuedBy: 'T', thirdParty: { name: 'Gestoría', nif: 'B12345674' }, coupon: false, billingAgreementNumber: 'ACU1', systemAgreementId: 'SYS1'
    }))
    const xml = buildSubmissionXml(header, [record])
    const names = childNames(xml, ['Envelope', 'Body', 'RegFactuSistemaFacturacion', 'RegistroFactura', 'RegistroAlta'])

    expect(names).toEqual(AltaOrder)
  })

  test('writes only the elements a record has, in schema order', () => {
    const names = childNames(buildSubmissionXml(header, [first()]), ['Envelope', 'Body', 'RegFactuSistemaFacturacion', 'RegistroFactura', 'RegistroAlta'])

    expect(inOrder(names, AltaOrder)).toBe(true)
    expect(names).toEqual(['IDVersion', 'IDFactura', 'NombreRazonEmisor', 'TipoFactura', 'DescripcionOperacion', 'Destinatarios', 'Desglose', 'CuotaTotal', 'ImporteTotal', 'Encadenamiento', 'SistemaInformatico', 'FechaHoraHusoGenRegistro', 'TipoHuella', 'Huella'])
  })

  test('writes dates as dd-mm-yyyy, amounts with two decimals, and the version 1.0', () => {
    const xml = buildSubmissionXml(header, [first()])

    expect(xml).toContain('<sum1:IDVersion>1.0</sum1:IDVersion>')
    expect(xml).toContain('<sum1:FechaExpedicionFactura>01-01-2024</sum1:FechaExpedicionFactura>')
    expect(xml).toContain('<sum1:CuotaTotal>12.35</sum1:CuotaTotal><sum1:ImporteTotal>123.45</sum1:ImporteTotal>')
    expect(xml).toContain(`<sum1:Huella>${AeatExamples.first.hash}</sum1:Huella>`)
  })

  test('writes the breakdown line in schema order, with the qualification or the exemption', () => {
    const taxed = buildSubmissionXml(header, [first()])
    const exempt = buildSubmissionXml(header, [createInvoiceRecord(invoiceInput({ breakdown: [{ tax: '01', regimeKey: '01', exemption: 'E1', taxableBase: 10, costBase: 5 }] }))])
    const line = ['Envelope', 'Body', 'RegFactuSistemaFacturacion', 'RegistroFactura', 'RegistroAlta', 'Desglose', 'DetalleDesglose']

    expect(childNames(taxed, line)).toEqual(['ClaveRegimen', 'CalificacionOperacion', 'TipoImpositivo', 'BaseImponibleOimporteNoSujeto', 'CuotaRepercutida'])
    expect(childNames(exempt, line)).toEqual(['Impuesto', 'ClaveRegimen', 'OperacionExenta', 'BaseImponibleOimporteNoSujeto', 'BaseImponibleACoste'])
  })

  test('writes the first record as PrimerRegistro and a later one with the previous record', () => {
    const a = first()
    const b = createInvoiceRecord(invoiceInput({ id: { issuerNif: IssuerNif, number: AeatExamples.second.number, issueDate: '2024-01-01' }, generatedAt: AeatExamples.second.generatedAt }), chainLinkOf(a))
    const xml = buildSubmissionXml(header, [a, b])

    expect(xml).toContain('<sum1:Encadenamiento><sum1:PrimerRegistro>S</sum1:PrimerRegistro></sum1:Encadenamiento>')
    expect(xml).toContain(`<sum1:RegistroAnterior><sum1:IDEmisorFactura>${IssuerNif}</sum1:IDEmisorFactura><sum1:NumSerieFactura>12345678/G33</sum1:NumSerieFactura><sum1:FechaExpedicionFactura>01-01-2024</sum1:FechaExpedicionFactura><sum1:Huella>${AeatExamples.first.hash}</sum1:Huella></sum1:RegistroAnterior>`)
  })

  test('writes the system block, with a foreign producer ID when there is no NIF', () => {
    const named = buildSubmissionXml(header, [first()])
    const foreign = buildSubmissionXml(header, [createInvoiceRecord(invoiceInput({ system: { ...system, producerNif: undefined, producerOtherId: { countryCode: 'DE', type: '02', id: 'DE123' } } }))])
    const path = ['Envelope', 'Body', 'RegFactuSistemaFacturacion', 'RegistroFactura', 'RegistroAlta', 'SistemaInformatico']

    expect(childNames(named, path)).toEqual(['NombreRazon', 'NIF', 'NombreSistemaInformatico', 'IdSistemaInformatico', 'Version', 'NumeroInstalacion', 'TipoUsoPosibleSoloVerifactu', 'TipoUsoPosibleMultiOT', 'IndicadorMultiplesOT'])
    expect(childNames(foreign, path)).toContain('IDOtro')
    expect(foreign).toContain('<sum1:IDOtro><sum1:CodigoPais>DE</sum1:CodigoPais><sum1:IDType>02</sum1:IDType><sum1:ID>DE123</sum1:ID></sum1:IDOtro>')
    expect(named).toContain('<sum1:TipoUsoPosibleSoloVerifactu>S</sum1:TipoUsoPosibleSoloVerifactu><sum1:TipoUsoPosibleMultiOT>N</sum1:TipoUsoPosibleMultiOT><sum1:IndicadorMultiplesOT>N</sum1:IndicadorMultiplesOT>')
  })

  test('writes a cancellation record in schema order', () => {
    const record = createCancellationRecord(cancellationInput({ externalRef: 'r', withoutPreviousRecord: false, previousRejection: 'S', generatedBy: 'T', generator: { name: 'Gestoría', nif: 'B12345674' } }), chainLinkOf(first()))
    const names = childNames(buildSubmissionXml(header, [record]), ['Envelope', 'Body', 'RegFactuSistemaFacturacion', 'RegistroFactura', 'RegistroAnulacion'])

    expect(names).toEqual(AnulacionOrder)
  })

  test('names the cancelled invoice with the "Anulada" element names', () => {
    const xml = buildSubmissionXml(header, [createCancellationRecord(cancellationInput(), chainLinkOf(first()))])

    expect(xml).toContain('<sum1:IDFactura><sum1:IDEmisorFacturaAnulada>89890001K</sum1:IDEmisorFacturaAnulada><sum1:NumSerieFacturaAnulada>12345679/G34</sum1:NumSerieFacturaAnulada><sum1:FechaExpedicionFacturaAnulada>01-01-2024</sum1:FechaExpedicionFacturaAnulada></sum1:IDFactura>')
  })

  test('puts alta and anulación records in one message, each in its own RegistroFactura', () => {
    const a = first()
    const xml = buildSubmissionXml(header, [a, createCancellationRecord(cancellationInput(), chainLinkOf(a))])

    expect(childNames(xml, ['Envelope', 'Body', 'RegFactuSistemaFacturacion'])).toEqual(['Cabecera', 'RegistroFactura', 'RegistroFactura'])
  })

  test('escapes text, so a name with & or < cannot break the message', () => {
    const xml = buildSubmissionXml(header, [createInvoiceRecord(invoiceInput({ description: 'Q&A <training> "pack"' }))])

    expect(xml).toContain('Q&amp;A &lt;training&gt; &quot;pack&quot;')
    expect(() => ordered.parse(xml)).not.toThrow()
  })
})

describe('buildQueryXml', () => {
  const base = { taxpayer: { name: 'Dave', nif: IssuerNif }, year: 2024, period: '11' as const }

  test('asks by year and period as the issuer', () => {
    const xml = buildQueryXml(base)

    expect(xml).toContain(`xmlns:con="${Namespaces.query}"`)
    expect(childNames(xml, ['Envelope', 'Body', 'ConsultaFactuSistemaFacturacion'])).toEqual(['Cabecera', 'FiltroConsulta'])
    expect(childNames(xml, ['Envelope', 'Body', 'ConsultaFactuSistemaFacturacion', 'Cabecera'])).toEqual(['IDVersion', 'ObligadoEmision'])
    expect(xml).toContain('<con:PeriodoImputacion><sum1:Ejercicio>2024</sum1:Ejercicio><sum1:Periodo>11</sum1:Periodo></con:PeriodoImputacion>')
  })

  test('asks as the recipient, and as an adviser', () => {
    const recipient = buildQueryXml({ recipient: { name: 'Cliente', nif: 'A58818501' }, year: '2024', period: '01' })
    const adviser = buildQueryXml({ ...base, asRepresentative: true })

    expect(childNames(recipient, ['Envelope', 'Body', 'ConsultaFactuSistemaFacturacion', 'Cabecera'])).toEqual(['IDVersion', 'Destinatario'])
    expect(childNames(adviser, ['Envelope', 'Body', 'ConsultaFactuSistemaFacturacion', 'Cabecera'])).toEqual(['IDVersion', 'ObligadoEmision', 'IndicadorRepresentante'])
  })

  test('needs exactly one of taxpayer or recipient', () => {
    expect(() => buildQueryXml({ year: 2024, period: '01' })).toThrow('exactly one')
    expect(() => buildQueryXml({ ...base, recipient: { name: 'x', nif: 'A58818501' } })).toThrow('exactly one')
  })

  test('filters in the order of the schema: number, counterparty, date, system, reference, page', () => {
    const xml = buildQueryXml({
      ...base,
      invoiceNumber: 'F-1',
      counterparty: { name: 'Cliente', nif: 'A58818501' },
      issueDate: { from: '2024-11-02', to: '2024-11-13' },
      system: { producerName: 'P', producerNif: 'B12345674', id: 'EX', installationNumber: '1' },
      externalRef: 'ref',
      pageKey: { issuerNif: IssuerNif, number: '10000', issueDate: '2024-11-28' },
      showIssuerName: true,
      showSystem: false
    })

    expect(childNames(xml, ['Envelope', 'Body', 'ConsultaFactuSistemaFacturacion', 'FiltroConsulta']))
      .toEqual(['PeriodoImputacion', 'NumSerieFactura', 'Contraparte', 'FechaExpedicionFactura', 'SistemaInformatico', 'RefExterna', 'ClavePaginacion'])
    expect(childNames(xml, ['Envelope', 'Body', 'ConsultaFactuSistemaFacturacion'])).toEqual(['Cabecera', 'FiltroConsulta', 'DatosAdicionalesRespuesta'])
    expect(xml).toContain('<sum1:RangoFechaExpedicion><sum1:Desde>02-11-2024</sum1:Desde><sum1:Hasta>13-11-2024</sum1:Hasta></sum1:RangoFechaExpedicion>')
    expect(xml).toContain('<con:MostrarNombreRazonEmisor>S</con:MostrarNombreRazonEmisor><con:MostrarSistemaInformatico>N</con:MostrarSistemaInformatico>')
  })

  test('filters by a single day', () => {
    expect(buildQueryXml({ ...base, issueDate: '2024-11-02' })).toContain('<con:FechaExpedicionFactura><sum1:FechaExpedicionFactura>02-11-2024</sum1:FechaExpedicionFactura></con:FechaExpedicionFactura>')
  })
})

describe('parseSubmissionReply', () => {
  test('reads a complete acceptance', () => {
    const reply = parseSubmissionReply(submissionReplyXml())

    expect(reply).toEqual({
      csv: 'A-ABCDEFGHIJ12',
      presentation: { presenterNif: IssuerNif, timestamp: '2024-01-01T19:21:00+01:00' },
      header: { taxpayer: { name: 'Dave Goodchild', nif: IssuerNif } },
      waitSeconds: 60,
      status: 'Correcto',
      records: [{
        id: { issuerNif: IssuerNif, number: '12345678/G33', issueDate: '2024-01-01' },
        operation: { type: 'Alta' },
        status: 'Correcto'
      }]
    })
  })

  test('reads a partial acceptance with an error, the wait AEAT asks for, and several records', () => {
    const reply = parseSubmissionReply(submissionReplyXml({
      status: 'ParcialmenteCorrecto',
      waitSeconds: 120,
      lines: [replyLine(), replyLine({ number: '2', state: 'Incorrecto', code: 1100, description: 'Valor del campo erroneo' }), replyLine({ number: '3', state: 'AceptadoConErrores', code: 2000, operation: 'Anulacion' })]
    }))

    expect(reply.status).toBe('ParcialmenteCorrecto')
    expect(reply.waitSeconds).toBe(120)
    expect(reply.records.map((record) => record.status)).toEqual(['Correcto', 'Incorrecto', 'AceptadoConErrores'])
    expect(reply.records[1]).toMatchObject({ errorCode: 1100, errorDescription: 'Valor del campo erroneo' })
    expect(reply.records[2].operation.type).toBe('Anulacion')
  })

  test('reads a record rejected as a duplicate with what AEAT holds', () => {
    const duplicate = `<tikR:RegistroDuplicado><tik:IdPeticionRegistroDuplicado>20240101192100360242</tik:IdPeticionRegistroDuplicado><tik:EstadoRegistroDuplicado>AceptadaConErrores</tik:EstadoRegistroDuplicado><tik:CodigoErrorRegistro>2000</tik:CodigoErrorRegistro><tik:DescripcionErrorRegistro>x</tik:DescripcionErrorRegistro></tikR:RegistroDuplicado>`
    const reply = parseSubmissionReply(submissionReplyXml({ status: 'Incorrecto', csv: null, lines: [replyLine({ state: 'Incorrecto', code: 3000, extra: duplicate })] }))

    expect(reply.csv).toBeUndefined()
    expect(reply.records[0].duplicate).toEqual({ requestId: '20240101192100360242', status: 'AceptadaConErrores', errorCode: 2000, errorDescription: 'x' })
  })

  test('reads the operation flags of a correction', () => {
    const operation = '<tikR:Operacion><tik:TipoOperacion>Alta</tik:TipoOperacion><tik:Subsanacion>S</tik:Subsanacion><tik:RechazoPrevio>X</tik:RechazoPrevio></tikR:Operacion>'
    const xml = submissionReplyXml({ lines: [replyLine().replace(/<tikR:Operacion>.*?<\/tikR:Operacion>/s, operation)] })

    expect(parseSubmissionReply(xml).records[0].operation).toEqual({ type: 'Alta', amendment: true, previousRejection: 'X' })
  })

  test('reads the header AEAT echoes, including the incident and requirement parts', () => {
    const xml = submissionReplyXml().replace('</tik:ObligadoEmision>', '</tik:ObligadoEmision><tik:RemisionVoluntaria><tik:FechaFinVeriFactu>31-12-2027</tik:FechaFinVeriFactu><tik:Incidencia>S</tik:Incidencia></tik:RemisionVoluntaria>')

    expect(parseSubmissionReply(xml).header).toEqual({ taxpayer: { name: 'Dave Goodchild', nif: IssuerNif }, voluntary: { verifactuEndDate: '2027-12-31', incident: true } })
  })

  test('always reads a single record as a list', () => {
    expect(parseSubmissionReply(submissionReplyXml({ lines: [replyLine()] })).records).toHaveLength(1)
    expect(parseSubmissionReply(submissionReplyXml({ lines: [] })).records).toEqual([])
  })

  test('throws the fault when the reply is a SOAP Fault', () => {
    expect(() => parseSubmissionReply(faultXml('env:Client', 'Codigo[4104].El NIF del titular en la cabecera no está identificado.'), 500)).toThrow(VerifactuSoapFaultError)
  })

  test('throws a response error for anything else', () => {
    expect(() => parseSubmissionReply('<html>Bad gateway</html>')).toThrow(VerifactuResponseError)
    expect(() => parseSubmissionReply('not xml at all')).toThrow(VerifactuResponseError)
    expect(() => parseSubmissionReply(faultXml('x', 'y').replace(/<env:Fault>.*<\/env:Fault>/s, '<other/>'))).toThrow('submission result')
    expect(() => parseSubmissionReply(submissionReplyXml().replace(/<tikR:EstadoEnvio>.*<\/tikR:EstadoEnvio>/s, ''))).toThrow('status or wait time')
  })
})

describe('parseSoapFault', () => {
  test('reads a client fault: the message is wrong, so it is not retryable, and the AEAT code is extracted', () => {
    const fault = parseSoapFault(faultXml('env:Client', 'Codigo[4104].El NIF del titular en la cabecera no está identificado.'), 500)

    expect(fault).toBeInstanceOf(VerifactuSoapFaultError)
    expect(fault).toMatchObject({ faultCode: 'env:Client', aeatCode: 4104, retryable: false, httpStatus: 500 })
    expect(fault?.faultString).toContain('El NIF del titular')
  })

  test('reads a server fault as retryable', () => {
    expect(parseSoapFault(faultXml('soapenv:Server', 'Internal error'))).toMatchObject({ retryable: true, aeatCode: null })
  })

  test('is null for a message that is not a fault, or not XML', () => {
    expect(parseSoapFault(submissionReplyXml())).toBeNull()
    expect(parseSoapFault('<html/>')).toBeNull()
    expect(parseSoapFault('')).toBeNull()
  })
})

describe('parseQueryReply', () => {
  const tik = 'xmlns:tik="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"'
  const rc = 'xmlns:tikLRRC="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd"'

  const record = (extra = '') => `<tikLRRC:RegistroRespuestaConsultaFactuSistemaFacturacion>
    <tikLRRC:IDFactura><tik:IDEmisorFactura>${IssuerNif}</tik:IDEmisorFactura><tik:NumSerieFactura>88</tik:NumSerieFactura><tik:FechaExpedicionFactura>27-11-2024</tik:FechaExpedicionFactura></tikLRRC:IDFactura>
    <tikLRRC:DatosRegistroFacturacion>
      <tikLRRC:TipoFactura>F1</tikLRRC:TipoFactura><tikLRRC:DescripcionOperacion>Servicios</tikLRRC:DescripcionOperacion>
      <tikLRRC:Destinatarios><tikLRRC:IDDestinatario><tik:NombreRazon>Cliente</tik:NombreRazon><tik:NIF>A84532509</tik:NIF></tikLRRC:IDDestinatario></tikLRRC:Destinatarios>
      <tikLRRC:Desglose><tik:DetalleDesglose><tik:Impuesto>01</tik:Impuesto><tik:ClaveRegimen>01</tik:ClaveRegimen><tik:CalificacionOperacion>S1</tik:CalificacionOperacion><tik:TipoImpositivo>4</tik:TipoImpositivo><tik:BaseImponibleOimporteNoSujeto>1044.03</tik:BaseImponibleOimporteNoSujeto><tik:CuotaRepercutida>41.76</tik:CuotaRepercutida></tik:DetalleDesglose></tikLRRC:Desglose>
      <tikLRRC:CuotaTotal>41.76</tikLRRC:CuotaTotal><tikLRRC:ImporteTotal>16976.37</tikLRRC:ImporteTotal>
      <tikLRRC:Encadenamiento><tikLRRC:RegistroAnterior><tik:IDEmisorFactura>${IssuerNif}</tik:IDEmisorFactura><tik:NumSerieFactura>87</tik:NumSerieFactura><tik:FechaExpedicionFactura>27-11-2024</tik:FechaExpedicionFactura><tik:Huella>${AeatExamples.first.hash}</tik:Huella></tikLRRC:RegistroAnterior></tikLRRC:Encadenamiento>
      <tikLRRC:FechaHoraHusoGenRegistro>2024-11-27T11:54:10+01:00</tikLRRC:FechaHoraHusoGenRegistro><tikLRRC:TipoHuella>01</tikLRRC:TipoHuella><tikLRRC:Huella>DAA7F72EEDC1AE8A294B7A011EC4A1EC2BE0E4DDB79AF3758377F8D61F38FE6B</tikLRRC:Huella>
      ${extra}
    </tikLRRC:DatosRegistroFacturacion>
    <tikLRRC:DatosPresentacion><tik:NIFPresentador>89890002E</tik:NIFPresentador><tik:TimestampPresentacion>2024-11-13T11:54:10+01:00</tik:TimestampPresentacion><tik:IdPeticion>20241113115410360242</tik:IdPeticion></tikLRRC:DatosPresentacion>
    <tikLRRC:EstadoRegistro><tikLRRC:TimestampUltimaModificacion>2024-11-27T11:54:10+01:00</tikLRRC:TimestampUltimaModificacion><tikLRRC:EstadoRegistro>Correcta</tikLRRC:EstadoRegistro></tikLRRC:EstadoRegistro>
  </tikLRRC:RegistroRespuestaConsultaFactuSistemaFacturacion>`

  const reply = (records: string, paging = 'N', next = '', result = 'ConDatos') => `<?xml version="1.0"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body Id="Body">
    <tikLRRC:RespuestaConsultaFactuSistemaFacturacion ${rc} ${tik}>
      <tikLRRC:Cabecera><tik:IDVersion>1.0</tik:IDVersion><tik:ObligadoEmision><tik:NombreRazon>E</tik:NombreRazon><tik:NIF>${IssuerNif}</tik:NIF></tik:ObligadoEmision></tikLRRC:Cabecera>
      <tikLRRC:PeriodoImputacion><tikLRRC:Ejercicio>2024</tikLRRC:Ejercicio><tikLRRC:Periodo>11</tikLRRC:Periodo></tikLRRC:PeriodoImputacion>
      <tikLRRC:IndicadorPaginacion>${paging}</tikLRRC:IndicadorPaginacion><tikLRRC:ResultadoConsulta>${result}</tikLRRC:ResultadoConsulta>
      ${records}${next}
    </tikLRRC:RespuestaConsultaFactuSistemaFacturacion></env:Body></env:Envelope>`

  test('reads AEAT\'s example: the record, its data, who presented it and its state', () => {
    const result = parseQueryReply(reply(record()))

    expect(result).toMatchObject({ year: '2024', period: '11', hasMore: false, hasData: true })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toEqual({
      id: { issuerNif: IssuerNif, number: '88', issueDate: '2024-11-27' },
      data: {
        invoiceType: 'F1',
        description: 'Servicios',
        recipients: [{ name: 'Cliente', nif: 'A84532509' }],
        breakdown: [{ tax: '01', regimeKey: '01', qualification: 'S1', taxRate: '4', taxableBase: '1044.03', taxAmount: '41.76' }],
        totalTax: '41.76',
        totalAmount: '16976.37',
        chaining: { previous: { issuerNif: IssuerNif, number: '87', issueDate: '2024-11-27', hash: AeatExamples.first.hash } },
        generatedAt: '2024-11-27T11:54:10+01:00',
        hashType: '01',
        hash: 'DAA7F72EEDC1AE8A294B7A011EC4A1EC2BE0E4DDB79AF3758377F8D61F38FE6B'
      },
      presentation: { presenterNif: '89890002E', timestamp: '2024-11-13T11:54:10+01:00', requestId: '20241113115410360242' },
      state: { lastModified: '2024-11-27T11:54:10+01:00', status: 'Correcta' }
    })
  })

  test('reads the representative, the end of VERI*FACTU and the incident flag of a record', () => {
    const result = parseQueryReply(reply(record('<tikLRRC:NifRepresentante>B12345674</tikLRRC:NifRepresentante><tikLRRC:FechaFinVeriFactu>31-12-2027</tikLRRC:FechaFinVeriFactu><tikLRRC:Incidencia>S</tikLRRC:Incidencia>')))

    expect(result.records[0].data).toMatchObject({ representativeNif: 'B12345674', verifactuEndDate: '2027-12-31', incident: true })
  })

  test('reads a page with more to come and where to continue', () => {
    const next = `<tikLRRC:ClavePaginacion><tik:IDEmisorFactura>${IssuerNif}</tik:IDEmisorFactura><tik:NumSerieFactura>10000</tik:NumSerieFactura><tik:FechaExpedicionFactura>28-11-2024</tik:FechaExpedicionFactura></tikLRRC:ClavePaginacion>`
    const result = parseQueryReply(reply(record() + record(), 'S', next))

    expect(result.hasMore).toBe(true)
    expect(result.records).toHaveLength(2)
    expect(result.nextPageKey).toEqual({ issuerNif: IssuerNif, number: '10000', issueDate: '2024-11-28' })
  })

  test('reads an empty answer', () => {
    expect(parseQueryReply(reply('', 'N', '', 'SinDatos'))).toMatchObject({ hasData: false, records: [] })
  })

  test('reads the first record of a chain, and a cancelled record\'s state', () => {
    const first = record().replace(/<tikLRRC:Encadenamiento>.*?<\/tikLRRC:Encadenamiento>/s, '<tikLRRC:Encadenamiento><tikLRRC:PrimerRegistro>S</tikLRRC:PrimerRegistro></tikLRRC:Encadenamiento>').replace('Correcta', 'Anulada')
    const result = parseQueryReply(reply(first))

    expect(result.records[0].data.chaining).toEqual({ first: true })
    expect(result.records[0].state.status).toBe('Anulada')
  })

  test('throws the fault, or a response error for another message', () => {
    expect(() => parseQueryReply(faultXml('env:Server', 'down'))).toThrow(VerifactuSoapFaultError)
    expect(() => parseQueryReply(submissionReplyXml())).toThrow('query result')
  })
})
