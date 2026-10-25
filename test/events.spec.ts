import { XMLParser } from 'fast-xml-parser'
import { VerifactuValidationError } from '~/errors'
import { computeEventHash, eventHashInput, verifyEventHash } from '~/hash'
import { eventRecordXml, EventNamespace } from '~/event-xml'
import { createEventRecord, eventLinkOf, verifyEventChain, type EventData, type EventRecordInput } from '~/events'
import { createSigner, signEventRecord } from '~/sign'
import { validateEventRecord } from '~/validate'
import { verifySignature } from '~/verify-signature'
import { AeatExamples, IssuerNif, makeSigningCertificate, pfxOf, system } from '@/helper/verifactu.helper'

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

const taxpayer = { name: 'Dave Goodchild', nif: IssuerNif }
const input = (overrides: Partial<EventRecordInput> = {}): EventRecordInput => ({ type: '01', taxpayer, system, generatedAt: '2024-01-01T19:20:30+01:00', ...overrides })
const codes = (record: ReturnType<typeof createEventRecord>) => validateEventRecord(record).map((issue) => `${issue.severity}:${issue.code}@${issue.path}`)

/** The order of the elements of `Evento` in EventosSIF.xsd */
const EventoOrder = [
  'SistemaInformatico', 'ObligadoEmision', 'EmitidaPorTerceroODestinatario', 'TerceroODestinatario', 'FechaHoraHusoGenEvento', 'TipoEvento', 'DatosPropiosEvento',
  'OtrosDatosEvento', 'Encadenamiento', 'TipoHuella', 'HuellaEvento', 'Signature'
]

const link = (number: string) => ({ issuerNif: IssuerNif, number, issueDate: '2024-01-01', hash: AeatExamples.first.hash })
const eventLink = { type: '01' as const, generatedAt: '2024-01-01T10:00:00+01:00', hash: AeatExamples.first.hash }
const run = (processed?: number) => ({ performed: true, processed })

type Of<K extends EventData['kind']> = Extract<EventData, { kind: K }>

const allData: Record<string, EventData> = {
  '03': { kind: 'billing-anomaly-check', hashes: run(120), signatures: run(120), chain: run(120), dates: { performed: false } },
  '04': { kind: 'billing-anomaly', anomaly: '01', details: 'Hash does not match', record: { issuerNif: IssuerNif, number: '12', issueDate: '2024-01-01' } },
  '05': { kind: 'event-anomaly-check', hashes: run(10), signatures: run(10), chain: run(10), dates: run(10) },
  '06': { kind: 'event-anomaly', anomaly: '07', details: 'Chain broken', event: eventLink },
  '08': { kind: 'billing-export', periodStart: '2024-01-01T00:00:00+01:00', periodEnd: '2024-01-31T23:59:59+01:00', first: link('1'), last: link('9'), altaCount: 8, totalTax: 21, totalAmount: '121', cancellationCount: 1, noLongerKept: false },
  '09': { kind: 'event-export', periodStart: '2024-01-01T00:00:00+01:00', periodEnd: '2024-01-31T23:59:59+01:00', first: eventLink, last: eventLink, count: 4, noLongerKept: true },
  '10': { kind: 'summary', counts: [{ type: '01', count: 1 }, { type: '03', count: 2 }], firstBilling: link('1'), lastBilling: link('9'), altaCount: 8, totalTax: '21.00', totalAmount: '121.00', cancellationCount: 1 }
}

describe('createEventRecord', () => {
  test('chains from the first event, with a hash over the fields AEAT\'s hash specification names', () => {
    const record = createEventRecord(input())

    expect(record.chaining).toEqual({ first: true })
    expect(record.hashType).toBe('01')
    expect(record.hash).toBe(computeEventHash({
      producerNif: system.producerNif, systemId: 'EX', version: '1.0.0', installationNumber: 'INSTALL-0001', taxpayerNif: IssuerNif, eventType: '01', previousHash: '', generatedAt: '2024-01-01T19:20:30+01:00'
    }))
    expect(eventHashInput({ producerNif: 'B1', systemId: 'EX', version: '1', installationNumber: '2', taxpayerNif: 'N', eventType: '01', previousHash: '', generatedAt: 't' }))
      .toBe('NIF=B1&ID=&IdSistemaInformatico=EX&Version=1&NumeroInstalacion=2&NIF=N&TipoEvento=01&HuellaEvento=&FechaHoraHusoGenEvento=t')
  })

  test('chains each event to the one before it, including its hash', () => {
    const first = createEventRecord(input())
    const second = createEventRecord(input({ type: '02', generatedAt: '2024-01-01T20:00:00+01:00' }), eventLinkOf(first))

    expect(eventLinkOf(first)).toEqual({ type: '01', generatedAt: '2024-01-01T19:20:30+01:00', hash: first.hash })
    expect(second.chaining).toEqual({ previous: eventLinkOf(first) })
    expect(second.hash).not.toBe(first.hash)
  })

  test('writes a Date in Spanish time, and trims text', () => {
    const record = createEventRecord(input({ type: '90', generatedAt: new Date('2024-07-01T17:20:30Z'), otherData: '  backup tested  ' }))

    expect(record.generatedAt).toBe('2024-07-01T19:20:30+02:00')
    expect(record.otherData).toBe('backup tested')
  })

  test('uses the producer\'s other ID, not its NIF, in the hash when it has no NIF', () => {
    const foreign = { ...system, producerNif: undefined, producerOtherId: { countryCode: 'DE', type: '02' as const, id: 'DE123' } }

    expect(createEventRecord(input({ system: foreign })).hash).toBe(computeEventHash({
      producerOtherId: 'DE123', systemId: 'EX', version: '1.0.0', installationNumber: 'INSTALL-0001', taxpayerNif: IssuerNif, eventType: '01', previousHash: '', generatedAt: '2024-01-01T19:20:30+01:00'
    }))
  })

  test('normalises timestamps and amounts inside the data of an export', () => {
    const record = createEventRecord(input({ type: '08', data: { ...(allData['08'] as Of<'billing-export'>), periodStart: new Date('2024-01-01T00:00:00Z'), totalTax: 21 } }))

    expect(record.data).toMatchObject({ periodStart: '2024-01-01T01:00:00+01:00', totalTax: '21.00', totalAmount: '121.00' })
  })

  test('throws every error when the event is wrong, unless asked not to check', () => {
    const wrong = input({ type: '03' })

    expect(() => createEventRecord(wrong)).toThrow(VerifactuValidationError)
    expect(createEventRecord(wrong, null, { validate: false }).type).toBe('03')
  })
})

describe('verifying events', () => {
  const first = () => createEventRecord(input())
  const second = () => createEventRecord(input({ type: '02', generatedAt: '2024-01-01T20:00:00+01:00' }), eventLinkOf(first()))
  const third = () => createEventRecord(input({ type: '90', otherData: 'x', generatedAt: '2024-01-01T21:00:00+01:00' }), eventLinkOf(second()))

  test('a hash matches its event until something changes', () => {
    expect(verifyEventHash(first())).toBe(true)
    expect(verifyEventHash({ ...first(), generatedAt: '2025-01-01T00:00:00+01:00' })).toBe(false)
  })

  test('a sound chain has no problems, from the start or continuing from an earlier event', () => {
    expect(verifyEventChain([first(), second(), third()])).toEqual([])
    expect(verifyEventChain([second(), third()], eventLinkOf(first()))).toEqual([])
  })

  test('finds a changed event, a removed one, and a wrong start', () => {
    expect(verifyEventChain([first(), { ...second(), generatedAt: '2030-01-01T00:00:00+01:00' }]).map((problem) => problem.code)).toContain('bad-hash')
    expect(verifyEventChain([first(), third()]).map((problem) => problem.code)).toEqual(['bad-link'])
    expect(verifyEventChain([second()]).map((problem) => problem.code)).toEqual(['missing-first'])
    expect(verifyEventChain([first(), first()]).map((problem) => problem.code)).toEqual(['unexpected-first'])
  })
})

describe('validateEventRecord', () => {
  test('finds nothing wrong with a sound event', () => {
    expect(codes(createEventRecord(input()))).toEqual([])
  })

  test.each(Object.keys(allData))('accepts event %s with its data', (type) => {
    expect(codes(createEventRecord(input({ type: type as never, data: allData[type] })))).toEqual([])
  })

  test('wants data for the types that carry it, and none for the others', () => {
    expect(codes(createEventRecord(input({ type: '08' }), null, { validate: false }))).toContain('error:data-expected@data')
    expect(codes(createEventRecord(input({ type: '08', data: allData['04'] }), null, { validate: false }))).toContain('error:data-expected@data')
    expect(codes(createEventRecord(input({ type: '01', data: allData['04'] }), null, { validate: false }))).toContain('error:data-unexpected@data')
  })

  test.each([
    ['text over 100 characters', { otherData: 'x'.repeat(101) }, 'text-too-long@otherData'],
    ['an unknown type', { type: '55' as never }, 'invalid-code@type'],
    ['a bad NIF', { taxpayer: { name: 'x', nif: '123' } }, 'nif-length@taxpayer.nif'],
    ['a timestamp without offset', { generatedAt: '2024-01-01T10:00:00' }, 'invalid-timestamp@generatedAt'],
    ['an unknown issuedBy', { issuedBy: 'X' as never }, 'invalid-code@issuedBy']
  ])('errors for %s', (_name, changes, expected) => {
    const record = { ...createEventRecord(input({ type: '90', otherData: 'ok' })), ...changes }

    expect(codes(record as never)).toContain(`error:${expected}`)
  })

  test('errors for data out of range: too many digits, too many types, an unknown anomaly', () => {
    const tooMany = createEventRecord(input({ type: '10', data: { ...(allData['10'] as Of<'summary'>), counts: Array.from({ length: 21 }, () => ({ type: '01' as const, count: 1 })) } }), null, { validate: false })
    const digits = createEventRecord(input({ type: '03', data: { ...(allData['03'] as Of<'billing-anomaly-check'>), hashes: run(12345678) } }), null, { validate: false })
    const anomaly = createEventRecord(input({ type: '04', data: { ...(allData['04'] as Of<'billing-anomaly'>), anomaly: '99' as never } }), null, { validate: false })

    expect(codes(tooMany)).toContain('error:too-many@data.counts')
    expect(codes(digits)).toContain('error:invalid-count@data.hashes.processed')
    expect(codes(anomaly)).toContain('error:invalid-code@data.anomaly')
  })

  test('warns of a changed event, and of an "other" event that says nothing', () => {
    expect(codes({ ...createEventRecord(input()), generatedAt: '2025-01-01T00:00:00+01:00' })).toContain('warning:hash-mismatch@hash')
    expect(codes(createEventRecord(input({ type: '90' })))).toContain('warning:description-expected@otherData')
  })

  test('errors when the chain is incomplete or the signature is not a signature', () => {
    expect(codes({ ...createEventRecord(input()), chaining: {} })).toContain('error:required@chaining.previous')
    expect(codes({ ...createEventRecord(input()), signature: '<x/>' })).toContain('error:invalid-signature@signature')
  })
})

describe('eventRecordXml', () => {
  const signer = (() => {
    const { authority, leaf } = makeSigningCertificate()
    return createSigner({ pfx: pfxOf(leaf, [authority.cert], 'secret'), passphrase: 'secret' })
  })()

  test('is RegistroEvento in the event schema\'s namespace, version 1.0, with the namespace declared on it', () => {
    const xml = eventRecordXml(createEventRecord(input()))

    expect(xml.startsWith(`<sf:RegistroEvento xmlns:sf="${EventNamespace}"><sf:IDVersion>1.0</sf:IDVersion><sf:Evento>`)).toBe(true)
    expect(childNames(xml, ['RegistroEvento'])).toEqual(['IDVersion', 'Evento'])
  })

  test('writes the elements of Evento in the order of the schema', async () => {
    const record = await signEventRecord(createEventRecord(input({
      type: '90', otherData: 'x', issuedBy: 'T', thirdParty: { name: 'Gestoría', nif: 'B12345674' }, data: undefined
    }), eventLinkOf(createEventRecord(input()))), signer)

    const names = childNames(eventRecordXml(record), ['RegistroEvento', 'Evento'])

    expect(names).toEqual(EventoOrder.filter((name) => name !== 'DatosPropiosEvento'))
  })

  test('has the first event as PrimerEvento and a later one with the event before it', () => {
    const first = createEventRecord(input())
    const second = createEventRecord(input({ type: '02', generatedAt: '2024-01-01T20:00:00+01:00' }), eventLinkOf(first))

    expect(eventRecordXml(first)).toContain('<sf:Encadenamiento><sf:PrimerEvento>S</sf:PrimerEvento></sf:Encadenamiento>')
    expect(eventRecordXml(second)).toContain(`<sf:EventoAnterior><sf:TipoEvento>01</sf:TipoEvento><sf:FechaHoraHusoGenEvento>2024-01-01T19:20:30+01:00</sf:FechaHoraHusoGenEvento><sf:HuellaEvento>${first.hash}</sf:HuellaEvento></sf:EventoAnterior>`)
  })

  test('writes the system, with the producer\'s other ID when it has no NIF', () => {
    const foreign = { ...system, producerNif: undefined, producerOtherId: { countryCode: 'DE', type: '02' as const, id: 'DE123' } }

    expect(childNames(eventRecordXml(createEventRecord(input())), ['RegistroEvento', 'Evento', 'SistemaInformatico']))
      .toEqual(['NombreRazon', 'NIF', 'NombreSistemaInformatico', 'IdSistemaInformatico', 'Version', 'NumeroInstalacion', 'TipoUsoPosibleSoloVerifactu', 'TipoUsoPosibleMultiOT', 'IndicadorMultiplesOT'])
    expect(eventRecordXml(createEventRecord(input({ system: foreign })))).toContain('<sf:IDOtro><sf:CodigoPais>DE</sf:CodigoPais><sf:IDType>02</sf:IDType><sf:ID>DE123</sf:ID></sf:IDOtro>')
  })

  test.each([
    ['03', 'LanzamientoProcesoDeteccionAnomaliasRegFacturacion', [
      'RealizadoProcesoSobreIntegridadHuellasRegFacturacion', 'NumeroDeRegistrosFacturacionProcesadosSobreIntegridadHuellas',
      'RealizadoProcesoSobreIntegridadFirmasRegFacturacion', 'NumeroDeRegistrosFacturacionProcesadosSobreIntegridadFirmas',
      'RealizadoProcesoSobreTrazabilidadCadenaRegFacturacion', 'NumeroDeRegistrosFacturacionProcesadosSobreTrazabilidadCadena',
      'RealizadoProcesoSobreTrazabilidadFechasRegFacturacion'
    ]],
    ['04', 'DeteccionAnomaliasRegFacturacion', ['TipoAnomalia', 'OtrosDatosAnomalia', 'RegistroFacturacionAnomalo']],
    ['05', 'LanzamientoProcesoDeteccionAnomaliasRegEvento', [
      'RealizadoProcesoSobreIntegridadHuellasRegEvento', 'NumeroDeRegistrosEventoProcesadosSobreIntegridadHuellas',
      'RealizadoProcesoSobreIntegridadFirmasRegEvento', 'NumeroDeRegistrosEventoProcesadosSobreIntegridadFirmas',
      'RealizadoProcesoSobreTrazabilidadCadenaRegEvento', 'NumeroDeRegistrosEventoProcesadosSobreTrazabilidadCadena',
      'RealizadoProcesoSobreTrazabilidadFechasRegEvento', 'NumeroDeRegistrosEventoProcesadosSobreTrazabilidadFechas'
    ]],
    ['06', 'DeteccionAnomaliasRegEvento', ['TipoAnomalia', 'OtrosDatosAnomalia', 'RegEventoAnomalo']],
    ['08', 'ExportacionRegFacturacionPeriodo', [
      'FechaHoraHusoInicioPeriodoExport', 'FechaHoraHusoFinPeriodoExport', 'RegistroFacturacionInicialPeriodo', 'RegistroFacturacionFinalPeriodo', 'NumeroDeRegistrosFacturacionAltaExportados',
      'SumaCuotaTotalAlta', 'SumaImporteTotalAlta', 'NumeroDeRegistrosFacturacionAnulacionExportados', 'RegistrosFacturacionExportadosDejanDeConservarse'
    ]],
    ['09', 'ExportacionRegEventoPeriodo', [
      'FechaHoraHusoInicioPeriodoExport', 'FechaHoraHusoFinPeriodoExport', 'RegistroEventoInicialPeriodo', 'RegistroEventoFinalPeriodo', 'NumeroDeRegEventoExportados', 'RegEventoExportadosDejanDeConservarse'
    ]],
    ['10', 'ResumenEventos', [
      'TipoEvento', 'TipoEvento', 'RegistroFacturacionInicialPeriodo', 'RegistroFacturacionFinalPeriodo', 'NumeroDeRegistrosFacturacionAltaGenerados', 'SumaCuotaTotalAlta', 'SumaImporteTotalAlta',
      'NumeroDeRegistrosFacturacionAnulacionGenerados'
    ]]
  ])('writes the data of event %s as %s, in schema order', (type, element, expected) => {
    const xml = eventRecordXml(createEventRecord(input({ type: type as never, data: allData[type] })))

    expect(childNames(xml, ['RegistroEvento', 'Evento', 'DatosPropiosEvento'])).toEqual([element])
    expect(childNames(xml, ['RegistroEvento', 'Evento', 'DatosPropiosEvento', element])).toEqual(expected)
  })

  test('writes the dates of the invoices in the data as dd-mm-yyyy', () => {
    const xml = eventRecordXml(createEventRecord(input({ type: '04', data: allData['04'] })))

    expect(xml).toContain('<sf:RegistroFacturacionAnomalo><sf:IDEmisorFactura>89890001K</sf:IDEmisorFactura><sf:NumSerieFactura>12</sf:NumSerieFactura><sf:FechaExpedicionFactura>01-01-2024</sf:FechaExpedicionFactura></sf:RegistroFacturacionAnomalo>')
  })

  test('is signed by signEventRecord: the signature is the last child of Evento, and verifies', async () => {
    const record = await signEventRecord(createEventRecord(input()), signer)

    expect(childNames(eventRecordXml(record), ['RegistroEvento', 'Evento']).slice(-2)).toEqual(['HuellaEvento', 'Signature'])
    expect(verifySignature(eventRecordXml(record)).problems).toEqual([])
    expect(verifySignature(eventRecordXml(record).replace('<sf:FechaHoraHusoGenEvento>2024-01-01', '<sf:FechaHoraHusoGenEvento>2025-01-01')).valid).toBe(false)
  })
})
