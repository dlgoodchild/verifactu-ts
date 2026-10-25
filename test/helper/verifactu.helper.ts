import { generateKeyPairSync } from 'crypto'
import forge from 'node-forge'
import type { HttpRequest, HttpResponse, VerifactuTransport } from '~/transport'
import type { CancellationRecordInput, InvoiceRecordInput, SoftwareSystem, SubmissionHeader } from '~/types'

/**
 * The first three example hashes from AEAT's hash specification (v0.1.2, section 6). They are the reference the hash
 * code must reproduce exactly.
 */
export const AeatExamples = {
  first: { hash: '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60', generatedAt: '2024-01-01T19:20:30+01:00', number: '12345678/G33' },
  second: { hash: 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97', generatedAt: '2024-01-01T19:20:35+01:00', number: '12345679/G34' },
  cancellation: { hash: '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68', generatedAt: '2024-01-01T19:20:40+01:00' }
}

export const IssuerNif = '89890001K'

export const system: SoftwareSystem = {
  producerName: 'Example Software SL',
  producerNif: 'B12345674',
  name: 'ExampleInvoicing',
  id: 'EX',
  version: '1.0.0',
  installationNumber: 'INSTALL-0001',
  onlyVerifactu: true,
  multiTaxpayer: false,
  multipleTaxpayersInUse: false
}

export const header: SubmissionHeader = { taxpayer: { name: 'Dave Goodchild', nif: IssuerNif } }

/** An invoice that matches AEAT's examples: total tax 12.35 and total 123.45 */
export function invoiceInput(overrides: Partial<InvoiceRecordInput> = {}): InvoiceRecordInput {
  return {
    id: { issuerNif: IssuerNif, number: AeatExamples.first.number, issueDate: '2024-01-01' },
    issuerName: 'Dave Goodchild',
    invoiceType: 'F1',
    description: 'Subscription',
    recipients: [{ name: 'Customer SL', nif: 'A58818501' }],
    breakdown: [{ regimeKey: '01', qualification: 'S1', taxRate: 11.12, taxableBase: '111.10', taxAmount: '12.35' }],
    system,
    generatedAt: AeatExamples.first.generatedAt,
    ...overrides
  }
}

export function cancellationInput(overrides: Partial<CancellationRecordInput> = {}): CancellationRecordInput {
  return {
    id: { issuerNif: IssuerNif, number: AeatExamples.second.number, issueDate: '2024-01-01' },
    system,
    generatedAt: AeatExamples.cancellation.generatedAt,
    ...overrides
  }
}

/** A transport that records what it was asked and answers from a queue (the last answer repeats) */
export class FakeTransport implements VerifactuTransport {
  readonly requests: HttpRequest[] = []

  constructor(private readonly answers: Array<HttpResponse | Error | ((request: HttpRequest) => HttpResponse)>) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request)
    const next = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(request) : next
  }
}

const info = 'xmlns:tik="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"'
const reply = 'xmlns:tikR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd"'

/** AEAT's reply to a submission, shaped as in its specification */
export function submissionReplyXml(options: { status?: string, waitSeconds?: number, csv?: string | null, lines?: string[] } = {}): string {
  const lines = options.lines ?? [replyLine()]
  return `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Header/><env:Body>
    <tikR:RespuestaRegFactuSistemaFacturacion ${reply} ${info}>
      ${options.csv === null ? '' : `<tikR:CSV>${options.csv ?? 'A-ABCDEFGHIJ12'}</tikR:CSV>`}
      <tikR:DatosPresentacion><tik:NIFPresentador>${IssuerNif}</tik:NIFPresentador><tik:TimestampPresentacion>2024-01-01T19:21:00+01:00</tik:TimestampPresentacion></tikR:DatosPresentacion>
      <tikR:Cabecera><tik:ObligadoEmision><tik:NombreRazon>Dave Goodchild</tik:NombreRazon><tik:NIF>${IssuerNif}</tik:NIF></tik:ObligadoEmision></tikR:Cabecera>
      <tikR:TiempoEsperaEnvio>${options.waitSeconds ?? 60}</tikR:TiempoEsperaEnvio>
      <tikR:EstadoEnvio>${options.status ?? 'Correcto'}</tikR:EstadoEnvio>
      ${lines.join('')}
    </tikR:RespuestaRegFactuSistemaFacturacion>
  </env:Body></env:Envelope>`
}

export function replyLine(options: { number?: string, state?: string, code?: number, description?: string, operation?: string, extra?: string } = {}): string {
  return `<tikR:RespuestaLinea>
    <tikR:IDFactura><tik:IDEmisorFactura>${IssuerNif}</tik:IDEmisorFactura><tik:NumSerieFactura>${options.number ?? AeatExamples.first.number}</tik:NumSerieFactura><tik:FechaExpedicionFactura>01-01-2024</tik:FechaExpedicionFactura></tikR:IDFactura>
    <tikR:Operacion><tik:TipoOperacion>${options.operation ?? 'Alta'}</tik:TipoOperacion></tikR:Operacion>
    <tikR:EstadoRegistro>${options.state ?? 'Correcto'}</tikR:EstadoRegistro>
    ${options.code !== undefined ? `<tikR:CodigoErrorRegistro>${options.code}</tikR:CodigoErrorRegistro>` : ''}
    ${options.description ? `<tikR:DescripcionErrorRegistro>${options.description}</tikR:DescripcionErrorRegistro>` : ''}
    ${options.extra ?? ''}
  </tikR:RespuestaLinea>`
}

export function faultXml(code: string, text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Header/><env:Body><env:Fault><faultcode>${code}</faultcode><faultstring>${text}</faultstring><detail><callstack>…</callstack></detail></env:Fault></env:Body></env:Envelope>`
}

export const ok = (body: string): HttpResponse => ({ status: 200, body })

export interface TestCertificate { cert: forge.pki.Certificate, privateKey: forge.pki.rsa.PrivateKey, pem: string, keyPem: string }

/** Makes an RSA certificate for `commonName`, signed by `issuer` (or by itself) */
export function makeCertificate(commonName: string, notBefore: Date, notAfter: Date, issuer?: TestCertificate): TestCertificate {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const privateKey = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e)
  cert.serialNumber = commonName === 'Leaf' ? '0A1B2C' : '01'
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter
  cert.setSubject([{ name: 'commonName', value: commonName }, { name: 'organizationName', value: 'Test Org' }])
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : cert.subject.attributes)
  cert.sign(issuer ? issuer.privateKey : privateKey, forge.md.sha256.create())
  return { cert, privateKey, pem: forge.pki.certificateToPem(cert), keyPem }
}

/** A PKCS#12 bundle of the certificate, its private key and any other certificates */
export function pfxOf(made: TestCertificate, others: forge.pki.Certificate[], password: string): Buffer {
  const asn1 = forge.pkcs12.toPkcs12Asn1(made.privateKey, [made.cert, ...others], password, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary')
}

/** A signing certificate issued by a test authority, valid around the given date */
export function makeSigningCertificate(around: Date = new Date()): { authority: TestCertificate, leaf: TestCertificate } {
  const day = 24 * 60 * 60 * 1000
  const authority = makeCertificate('Authority', new Date(around.getTime() - 3650 * day), new Date(around.getTime() + 3650 * day))
  const leaf = makeCertificate('Leaf', new Date(around.getTime() - 30 * day), new Date(around.getTime() + 335 * day), authority)
  return { authority, leaf }
}
