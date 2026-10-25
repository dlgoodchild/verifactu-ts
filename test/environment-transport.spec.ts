import http from 'http'
import { AddressInfo } from 'net'
import { serviceUrl, validationBaseUrl, wsdlUrl } from '~/environment'
import { VerifactuConfigurationError, VerifactuTransportError } from '~/errors'
import { HttpsTransport } from '~/transport'
import { CountryCodes, isCountryCode } from '~/country-codes'
import { InvoiceTypes, OperationQualifications, OtherIdTypes, RegimeKeys } from '~/codes'

describe('environment', () => {
  test('has the four addresses of AEAT\'s service definition for VERI*FACTU mode', () => {
    expect(serviceUrl('production', 'personal')).toBe('https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP')
    expect(serviceUrl('production', 'seal')).toBe('https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP')
    expect(serviceUrl('test', 'personal')).toBe('https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP')
    expect(serviceUrl('test', 'seal')).toBe('https://prewww10.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP')
  })

  test('has the requirement service, and defaults to a personal certificate', () => {
    expect(serviceUrl('production', 'personal', 'requirement')).toBe('https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/RequerimientoSOAP')
    expect(serviceUrl('test')).toBe(serviceUrl('test', 'personal', 'verifactu'))
  })

  test('has the service definitions and the validation service', () => {
    expect(wsdlUrl('production')).toBe('https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/cont/ws/SistemaFacturacion.wsdl')
    expect(wsdlUrl('test')).toContain('https://prewww2.aeat.es/')
    expect(validationBaseUrl('production')).toBe('https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR')
    expect(validationBaseUrl('test', false)).toBe('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu')
  })
})

describe('code lists', () => {
  test('hold the values AEAT\'s schema has', () => {
    expect(InvoiceTypes).toEqual(['F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5'])
    expect(OperationQualifications).toEqual(['S1', 'S2', 'N1', 'N2'])
    expect(OtherIdTypes).toEqual(['02', '03', '04', '05', '06', '07'])
    expect(RegimeKeys).toContain('17')
    expect(RegimeKeys).not.toContain('12')
  })

  test('hold AEAT\'s country codes, including the extras it adds', () => {
    expect(CountryCodes.length).toBe(246)
    for (const code of ['ES', 'DE', 'FR', 'US', 'GB', 'XB', 'XU', 'XN']) {
      expect(isCountryCode(code)).toBe(true)
    }
    expect(isCountryCode('ZZ')).toBe(false)
    expect(isCountryCode('es')).toBe(false)
    expect(new Set(CountryCodes).size).toBe(CountryCodes.length)
  })
})

describe('HttpsTransport', () => {
  test('reports a certificate that cannot be read when it is created', () => {
    expect(() => new HttpsTransport({ certificate: { pfx: Buffer.from('garbage'), passphrase: 'x' } })).toThrow(VerifactuConfigurationError)
    expect(() => new HttpsTransport({ certificate: { passphrase: 'x' } })).toThrow('PKCS#12 bundle (pfx) or a PEM certificate and key')
  })

  test('can be used without a certificate for the public validation service', () => {
    const transport = new HttpsTransport()
    transport.close()
  })

  test('reports a failed connection as a transport error', async () => {
    const closed = await new Promise<number>((resolve) => {
      const server = http.createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        server.close(() => resolve(port))
      })
    })
    const transport = new HttpsTransport()

    const error = await transport.send({ url: `https://127.0.0.1:${closed}/ws`, method: 'POST', headers: {}, body: '<x/>', timeoutMs: 2000 }).catch((caught) => caught)

    expect(error).toBeInstanceOf(VerifactuTransportError)
    expect(error.retryable).toBe(true)
    transport.close()
  })

  test('gives up after the timeout', async () => {
    const hanging = http.createServer(() => undefined)
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve))
    const { port } = hanging.address() as AddressInfo
    const transport = new HttpsTransport()

    // A plain HTTP server cannot complete a TLS handshake, so the connection never gets an answer
    const error = await transport.send({ url: `https://127.0.0.1:${port}/ws`, method: 'GET', headers: {}, timeoutMs: 200 }).catch((caught) => caught)

    expect(error).toBeInstanceOf(VerifactuTransportError)
    transport.close()
    hanging.closeAllConnections()
    await new Promise<void>((resolve) => hanging.close(() => resolve()))
  })
})
