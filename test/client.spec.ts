import { VerifactuClient } from '~/client'
import {
  VerifactuBatchError, VerifactuConfigurationError, VerifactuResponseError, VerifactuSoapFaultError, VerifactuTransportError, VerifactuValidationError
} from '~/errors'
import { FlowControl } from '~/flow-control'
import { chainLinkOf } from '~/hash'
import { createCancellationRecord, createInvoiceRecord } from '~/record'
import type { BillingRecord } from '~/types'
import { AeatExamples, cancellationInput, faultXml, FakeTransport, header, invoiceInput, IssuerNif, ok, replyLine, submissionReplyXml } from '@/helper/verifactu.helper'

const record = () => createInvoiceRecord(invoiceInput())

/** `count` records in chain order, each an invoice with its own number */
function chain(count: number): BillingRecord[] {
  const records: BillingRecord[] = []
  for (let index = 0; index < count; index++) {
    records.push(createInvoiceRecord(
      invoiceInput({ id: { issuerNif: IssuerNif, number: `INV-${index + 1}`, issueDate: '2024-01-01' } }),
      index === 0 ? null : chainLinkOf(records[index - 1])
    ))
  }
  return records
}

const clientWith = (transport: FakeTransport, options: Partial<ConstructorParameters<typeof VerifactuClient>[0]> = {}) =>
  new VerifactuClient({ environment: 'test', transport, ...options })

describe('VerifactuClient set-up', () => {
  test('uses the address of the environment, certificate kind and service', () => {
    const transport = new FakeTransport([ok('')])

    expect(clientWith(transport).url).toBe('https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP')
    expect(clientWith(transport, { environment: 'production' }).url).toBe('https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP')
    expect(clientWith(transport, { environment: 'production', certificateKind: 'seal' }).url).toBe('https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP')
    expect(clientWith(transport, { mode: 'requirement' }).url).toBe('https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/RequerimientoSOAP')
    expect(clientWith(transport, { endpoint: 'https://stub.example/ws' }).url).toBe('https://stub.example/ws')
  })

  test('needs a certificate or a transport', () => {
    expect(() => new VerifactuClient({ environment: 'test' })).toThrow(VerifactuConfigurationError)
  })

  test('refuses a certificate that cannot be read, before any request', () => {
    expect(() => new VerifactuClient({ environment: 'test', certificate: { pfx: Buffer.from('not a certificate'), passphrase: 'x' } })).toThrow(VerifactuConfigurationError)
  })
})

describe('submit', () => {
  test('posts the SOAP message to the service and reads the reply', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml())])

    const reply = await clientWith(transport).submit(header, [record()])

    expect(reply).toMatchObject({ status: 'Correcto', waitSeconds: 60, csv: 'A-ABCDEFGHIJ12' })
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]).toMatchObject({
      url: 'https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' },
      timeoutMs: 60_000
    })
    expect(transport.requests[0].body).toContain('<sum:RegFactuSistemaFacturacion>')
    expect(transport.requests[0].body).toContain(AeatExamples.first.hash)
  })

  test('sends alta and anulación records together', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml({ lines: [replyLine(), replyLine({ operation: 'Anulacion' })] }))])
    const a = record()

    const reply = await clientWith(transport).submit(header, [a, createCancellationRecord(cancellationInput({ id: a.id }), chainLinkOf(a))])

    expect(reply.records.map((entry) => entry.operation.type)).toEqual(['Alta', 'Anulacion'])
    expect(transport.requests[0].body).toContain('<sum1:RegistroAnulacion>')
  })

  test('uses the timeout it was given', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml())])

    await clientWith(transport, { timeoutMs: 5000 }).submit(header, [record()])

    expect(transport.requests[0].timeoutMs).toBe(5000)
  })

  test('sends nothing when a record has an error', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml())])
    const broken = { ...record(), description: '' }

    await expect(clientWith(transport).submit(header, [broken])).rejects.toThrow(VerifactuValidationError)
    await expect(clientWith(transport).submit(header, [])).rejects.toThrow(VerifactuValidationError)
    expect(transport.requests).toHaveLength(0)
  })

  test('sends despite warnings, which are for the caller to look at', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml())])
    const client = clientWith(transport)
    const other = createInvoiceRecord(invoiceInput({ id: { issuerNif: 'B12345674', number: '1', issueDate: '2024-01-01' } }))

    expect(client.check(header, [other]).map((issue) => issue.severity)).toEqual(['warning'])
    await expect(client.submit(header, [other])).resolves.toBeDefined()
  })

  test('can skip the local check', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml())])

    await clientWith(transport, { validate: false }).submit(header, [{ ...record(), description: '' }])

    expect(transport.requests).toHaveLength(1)
  })

  test('exposes the message it would send', () => {
    const client = clientWith(new FakeTransport([ok('')]))

    expect(client.buildSubmission(header, [record()])).toContain('<soapenv:Envelope')
  })

  describe('when it goes wrong', () => {
    test('a Client fault is not retryable and carries AEAT\'s code', async () => {
      const transport = new FakeTransport([{ status: 500, body: faultXml('env:Client', 'Codigo[4104].El NIF del titular en la cabecera no está identificado.') }])

      const error = await clientWith(transport).submit(header, [record()]).catch((caught) => caught)

      expect(error).toBeInstanceOf(VerifactuSoapFaultError)
      expect(error).toMatchObject({ aeatCode: 4104, retryable: false, httpStatus: 500 })
    })

    test('a Server fault is retryable', async () => {
      const transport = new FakeTransport([{ status: 500, body: faultXml('env:Server', 'Servicio no disponible') }])

      await expect(clientWith(transport).submit(header, [record()])).rejects.toMatchObject({ retryable: true })
    })

    test('a reply that is not the expected XML is a response error to resend after', async () => {
      const transport = new FakeTransport([{ status: 502, body: '<html>Bad Gateway</html>' }])

      const error = await clientWith(transport).submit(header, [record()]).catch((caught) => caught)

      expect(error).toBeInstanceOf(VerifactuResponseError)
      expect(error).toMatchObject({ retryable: true, httpStatus: 502 })
    })

    test('an unexpected HTTP status with a good-looking body is still an error', async () => {
      const transport = new FakeTransport([{ status: 503, body: submissionReplyXml() }])

      await expect(clientWith(transport).submit(header, [record()])).rejects.toThrow('HTTP 503')
    })

    test('a network failure is a transport error, whose outcome is unknown', async () => {
      const transport = new FakeTransport([new VerifactuTransportError('connection reset')])

      await expect(clientWith(transport).submit(header, [record()])).rejects.toMatchObject({ retryable: true, message: 'connection reset' })
    })
  })
})

describe('submitInBatches', () => {
  test('sends records in batches of at most 1000, in order, and returns every reply', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml({ waitSeconds: 60 }))])
    const records = chain(2500)

    const replies = await clientWith(transport, { validate: false }).submitInBatches(header, records, { sleep: async () => undefined })

    expect(replies).toHaveLength(3)
    const sent = transport.requests.map((request) => (request.body!.match(/<sum1:RegistroAlta>/g) ?? []).length)
    expect(sent).toEqual([1000, 1000, 500])
    expect(transport.requests[0].body).toContain('INV-1<')
    expect(transport.requests[2].body).toContain('INV-2500<')
  })

  test('does not wait between full batches, but waits as AEAT asked before a last, smaller one', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml({ waitSeconds: 90 }))])
    let clock = new Date('2024-01-01T10:00:00Z').getTime()
    const sleeps: number[] = []

    await clientWith(transport, { validate: false }).submitInBatches(header, chain(2500), {
      now: () => new Date(clock),
      sleep: async (ms) => { sleeps.push(ms); clock += ms }
    })

    // The second batch goes at once (1500 records are waiting); the third has 500 left, so it waits the 90 seconds AEAT asked
    expect(sleeps).toEqual([90_000])
  })

  test('waits before the first batch when the previous submission was moments ago', async () => {
    const flow = new FlowControl({ waitSeconds: 60, lastSentAt: new Date('2024-01-01T10:00:00Z') })
    const sleeps: number[] = []

    await clientWith(new FakeTransport([ok(submissionReplyXml())])).submitInBatches(header, [record()], {
      flow,
      now: () => new Date('2024-01-01T10:00:20Z'),
      sleep: async (ms) => { sleeps.push(ms) }
    })

    expect(sleeps).toEqual([40_000])
    expect(flow.wait).toBe(60)
  })

  test('calls back after each batch, so the outcome can be saved before the next goes out', async () => {
    const seen: Array<{ index: number, count: number, status: string }> = []

    await clientWith(new FakeTransport([ok(submissionReplyXml())]), { validate: false }).submitInBatches(header, chain(1500), {
      sleep: async () => undefined,
      onBatch: (reply, records, index) => { seen.push({ index, count: records.length, status: reply.status }) }
    })

    expect(seen).toEqual([{ index: 0, count: 1000, status: 'Correcto' }, { index: 1, count: 500, status: 'Correcto' }])
  })

  test('stops at the first failure, keeping the replies of the batches that were answered', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml()), { status: 500, body: faultXml('env:Server', 'down') }])

    const error = await clientWith(transport, { validate: false }).submitInBatches(header, chain(2500), { sleep: async () => undefined }).catch((caught) => caught)

    expect(error).toBeInstanceOf(VerifactuBatchError)
    expect(error.completed).toHaveLength(1)
    expect(error.cause).toBeInstanceOf(VerifactuSoapFaultError)
    expect(error.message).toContain('Batch 2 of 3')
    expect(transport.requests).toHaveLength(2)
  })

  test('sends nothing for no records', async () => {
    const transport = new FakeTransport([ok(submissionReplyXml())])

    expect(await clientWith(transport).submitInBatches(header, [])).toEqual([])
    expect(transport.requests).toHaveLength(0)
  })

  test('keeps the flow control across calls', async () => {
    const flow = new FlowControl()
    const transport = new FakeTransport([ok(submissionReplyXml({ waitSeconds: 75 }))])

    await clientWith(transport).submitInBatches(header, [record()], { flow, now: () => new Date('2024-01-01T10:00:00Z') })

    expect(flow.wait).toBe(75)
    expect(flow.lastSent?.toISOString()).toBe('2024-01-01T10:00:00.000Z')
  })
})

describe('query', () => {
  const tik = 'xmlns:tik="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"'
  const rc = 'xmlns:r="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd"'
  const entry = (number: string) => `<r:RegistroRespuestaConsultaFactuSistemaFacturacion><r:IDFactura><tik:IDEmisorFactura>${IssuerNif}</tik:IDEmisorFactura><tik:NumSerieFactura>${number}</tik:NumSerieFactura><tik:FechaExpedicionFactura>01-11-2024</tik:FechaExpedicionFactura></r:IDFactura><r:DatosRegistroFacturacion/><r:EstadoRegistro><r:TimestampUltimaModificacion>2024-11-01T10:00:00+01:00</r:TimestampUltimaModificacion><r:EstadoRegistro>Correcta</r:EstadoRegistro></r:EstadoRegistro></r:RegistroRespuestaConsultaFactuSistemaFacturacion>`
  const page = (numbers: string[], next?: string) => `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><r:RespuestaConsultaFactuSistemaFacturacion ${rc} ${tik}>
    <r:Cabecera><tik:IDVersion>1.0</tik:IDVersion></r:Cabecera><r:PeriodoImputacion><r:Ejercicio>2024</r:Ejercicio><r:Periodo>11</r:Periodo></r:PeriodoImputacion>
    <r:IndicadorPaginacion>${next ? 'S' : 'N'}</r:IndicadorPaginacion><r:ResultadoConsulta>ConDatos</r:ResultadoConsulta>
    ${numbers.map(entry).join('')}${next ? `<r:ClavePaginacion><tik:IDEmisorFactura>${IssuerNif}</tik:IDEmisorFactura><tik:NumSerieFactura>${next}</tik:NumSerieFactura><tik:FechaExpedicionFactura>01-11-2024</tik:FechaExpedicionFactura></r:ClavePaginacion>` : ''}
  </r:RespuestaConsultaFactuSistemaFacturacion></env:Body></env:Envelope>`
  const query = { taxpayer: header.taxpayer, year: 2024, period: '11' as const }

  test('asks the service and reads the records', async () => {
    const transport = new FakeTransport([ok(page(['1', '2']))])

    const reply = await clientWith(transport).query(query)

    expect(reply.records.map((entry) => entry.id.number)).toEqual(['1', '2'])
    expect(transport.requests[0].body).toContain('<con:ConsultaFactuSistemaFacturacion>')
  })

  test('follows the pagination key to the end, one page at a time', async () => {
    const transport = new FakeTransport([ok(page(['1', '2'], '2')), ok(page(['3', '4'], '4')), ok(page(['5']))])

    const records = await clientWith(transport).queryAll(query)

    expect(records.map((entry) => entry.id.number)).toEqual(['1', '2', '3', '4', '5'])
    expect(transport.requests).toHaveLength(3)
    expect(transport.requests[0].body).not.toContain('ClavePaginacion')
    expect(transport.requests[1].body).toContain('<con:ClavePaginacion><sum1:IDEmisorFactura>89890001K</sum1:IDEmisorFactura><sum1:NumSerieFactura>2</sum1:NumSerieFactura>')
    expect(transport.requests[2].body).toContain('<sum1:NumSerieFactura>4</sum1:NumSerieFactura>')
  })

  test('is not available in the requirement service', async () => {
    await expect(clientWith(new FakeTransport([ok('')]), { mode: 'requirement' }).query(query)).rejects.toThrow(VerifactuConfigurationError)
  })

  test('throws AEAT\'s fault', async () => {
    const transport = new FakeTransport([{ status: 500, body: faultXml('env:Client', 'Codigo[4102].XML mal formado') }])

    await expect(clientWith(transport).query(query)).rejects.toMatchObject({ aeatCode: 4102 })
  })
})
