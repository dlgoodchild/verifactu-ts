import { verifyInvoice } from '~/validation-service'
import { VerifactuResponseError } from '~/errors'
import { FakeTransport, ok } from '@/helper/verifactu.helper'

const content = { nif: '89890001K', number: '12345678-G33', issueDate: '2024-09-01', amount: 241.4 }
const json = (value: unknown) => ok(JSON.stringify(value))

describe('verifyInvoice', () => {
  test('asks for the JSON answer on the validation URL, with the four parameters', async () => {
    const transport = new FakeTransport([json({ status: 'OK', mensaje: 'Encontrada', respuesta: { resultado: '00', nif: '89890001K', numserie: '12345678-G33', fecha: '01-09-2024', importe: '241.40' } })])

    await verifyInvoice(content, { environment: 'test', transport })

    expect(transport.requests[0]).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } })
    expect(transport.requests[0].url).toBe('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678-G33&fecha=01-09-2024&importe=241.40&formato=json')
  })

  test('reads "found" (result 00)', async () => {
    const transport = new FakeTransport([json({ status: 'OK', mensaje: 'Encontrada', visible: 'N', crashlytics: 'N', respuesta: { resultado: '00', nif: '89890001K', numserie: '12345678-G33', fecha: '01-09-2024', importe: '241.40' } })])

    expect(await verifyInvoice(content, { environment: 'production', transport })).toEqual({
      outcome: 'found', message: 'Encontrada', status: 'OK', resultCode: '00', errorCodes: [], invoice: { nif: '89890001K', number: '12345678-G33', issueDate: '01-09-2024', amount: '241.40' }
    })
  })

  test('reads "not found" (result 01) and "not verifiable" (result 02)', async () => {
    const notFound = new FakeTransport([json({ status: 'OK', mensaje: 'No encontrada', respuesta: { resultado: '01', nif: '89890001K' } })])
    const notVerifiable = new FakeTransport([json({ status: 'OK', mensaje: 'No contrastable', respuesta: { resultado: '02', nif: '89890001K' } })])

    expect((await verifyInvoice(content, { environment: 'test', transport: notFound })).outcome).toBe('not-found')
    expect((await verifyInvoice(content, { environment: 'test', transport: notVerifiable })).outcome).toBe('not-verifiable')
  })

  test('reads an error answer, with its codes (several are joined by a point)', async () => {
    const transport = new FakeTransport([json({ status: 'KO', mensaje: 'No se ha remitido el parámetro: fecha', visible: 'S', crashlytics: 'N', codigo_error: '1003.1004' })])

    expect(await verifyInvoice(content, { environment: 'test', transport })).toEqual({
      outcome: 'error', message: 'No se ha remitido el parámetro: fecha', status: 'KO', errorCodes: ['1003', '1004']
    })
  })

  test('can use a language, and the non-verifiable service', async () => {
    const transport = new FakeTransport([json({ status: 'OK', mensaje: 'No contrastable', respuesta: { resultado: '02' } })])

    await verifyInvoice(content, { environment: 'test', transport, language: 'en', verifiable: false })

    expect(transport.requests[0].url).toContain('/ValidarQRNoVerifactu?')
    expect(transport.requests[0].url).toContain('&idioma=en&formato=json')
  })

  test('throws when the answer is not JSON', async () => {
    const transport = new FakeTransport([{ status: 503, body: '<html>unavailable</html>' }])

    await expect(verifyInvoice(content, { environment: 'test', transport })).rejects.toThrow(VerifactuResponseError)
  })

  test('refuses content that could not be in a QR code, before any request', async () => {
    const transport = new FakeTransport([ok('{}')])

    await expect(verifyInvoice({ ...content, nif: '1' }, { environment: 'test', transport })).rejects.toThrow('9 characters')
    expect(transport.requests).toHaveLength(0)
  })
})
