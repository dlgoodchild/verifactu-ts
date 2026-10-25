import https from 'https'
import tls from 'tls'
import { pkcs12ToPem } from '~/certificate'
import { VerifactuConfigurationError, VerifactuTransportError } from '~/errors'

/**
 * Sending HTTP requests. The client talks to AEAT through this small interface, so tests (and callers with their own
 * HTTP stack) can supply a different one. `HttpsTransport` is the real one, with a client certificate.
 */

export interface HttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

export interface HttpResponse {
  status: number
  body: string
}

export interface VerifactuTransport {
  /** Performs the request. Throws `VerifactuTransportError` when no answer could be had (network, TLS, timeout). */
  send(request: HttpRequest): Promise<HttpResponse>
}

/** A client certificate: a PKCS#12 bundle (`.p12`/`.pfx`), or a PEM certificate with its key */
export interface ClientCertificate {
  /** A PKCS#12 bundle, as a Buffer or as base64 text */
  pfx?: Buffer | string
  /** A PEM certificate, with `key`; use this or `pfx` */
  cert?: Buffer | string
  key?: Buffer | string
  passphrase?: string
}

export interface HttpsTransportOptions {
  /** The certificate AEAT authenticates the sender with; not needed for the public validation service */
  certificate?: ClientCertificate
  /** Extra certificate authorities to trust, for a proxy or a test server */
  ca?: string | Buffer
  /** The largest reply accepted, in bytes (default 25 MB: a query can return 10000 records) */
  maxResponseBytes?: number
}

const DefaultMaxResponseBytes = 25 * 1024 * 1024

/** A base64 text is a certificate file given as text; anything else is used as it is */
const asBuffer = (value: Buffer | string): Buffer | string => (typeof value === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(value) && !value.includes('-----') ? Buffer.from(value, 'base64') : value)

/** Sends requests with Node's `https`, authenticating with the client certificate */
export class HttpsTransport implements VerifactuTransport {
  private readonly agent: https.Agent
  private readonly maxResponseBytes: number

  constructor(options: HttpsTransportOptions = {}) {
    const certificate = options.certificate
    const material: https.AgentOptions = { keepAlive: true, ...(options.ca ? { ca: options.ca } : {}) }

    if (certificate?.pfx) {
      material.pfx = asBuffer(certificate.pfx)
      material.passphrase = certificate.passphrase
    }
    else if (certificate) {
      if (!certificate.cert || !certificate.key) {
        throw new VerifactuConfigurationError('A client certificate needs either a PKCS#12 bundle (pfx) or a PEM certificate and key')
      }
      material.cert = certificate.cert
      material.key = certificate.key
      material.passphrase = certificate.passphrase
    }

    if (certificate) {
      try {
        // Opens the certificate now, so a wrong password or a damaged file is reported here and not on the first request
        tls.createSecureContext(material)
      }
      catch (error) {
        // OpenSSL 3 (Node 17+) refuses bundles protected with legacy algorithms (RC2/3DES), as many .p12 files from
        // Spanish certificate authorities are ("Unsupported PKCS12 PFX data"). node-forge can read them, so convert
        // the bundle to PEM and hand that to TLS instead.
        if (!material.pfx) throw new VerifactuConfigurationError(`The client certificate could not be read: ${(error as Error).message}`)
        try {
          const pem = pkcs12ToPem(material.pfx as Buffer | string, material.passphrase)
          delete material.pfx
          delete material.passphrase
          material.cert = pem.cert
          material.key = pem.key
          tls.createSecureContext(material)
        }
        catch (fallbackError) {
          if (fallbackError instanceof VerifactuConfigurationError) throw fallbackError
          throw new VerifactuConfigurationError(`The client certificate could not be read: ${(fallbackError as Error).message}`)
        }
      }
    }

    this.agent = new https.Agent(material)
    this.maxResponseBytes = options.maxResponseBytes ?? DefaultMaxResponseBytes
  }

  /** Closes idle connections */
  close(): void {
    this.agent.destroy()
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      const url = new URL(request.url)
      const body = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8')

      const req = https.request({
        agent: this.agent,
        method: request.method,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: { ...request.headers, ...(body ? { 'Content-Length': String(body.length) } : {}) },
        timeout: request.timeoutMs
      }, (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > this.maxResponseBytes) {
            req.destroy(new Error(`The reply is larger than ${this.maxResponseBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', (error) => reject(new VerifactuTransportError(`The reply could not be read: ${error.message}`, error)))
      })

      req.on('timeout', () => req.destroy(new Error(`No answer within ${request.timeoutMs} ms`)))
      req.on('error', (error) => reject(new VerifactuTransportError(`The request to ${url.hostname} failed: ${error.message}`, error)))
      if (body) req.write(body)
      req.end()
    })
  }
}
