import crypto, { X509Certificate, type KeyObject } from 'crypto'
import { canonicalize, findById, findElement, parseXml } from '~/c14n'
import { openPkcs12 } from '~/certificate'
import { eventRecordXml } from '~/event-xml'
import type { EventRecord } from '~/events'
import { VerifactuConfigurationError } from '~/errors'
import { formatTimestamp } from '~/format'
import type { ClientCertificate } from '~/transport'
import type { BillingRecord } from '~/types'
import { cancellationRecordXml, invoiceRecordXml } from '~/xml'
import { escapeXml, insertBeforeClosing } from '~/xml-write'
import forge from 'node-forge'

/**
 * Signing records (XAdES). Systems that do not send records to AEAT routinely (the "non-VERI*FACTU" way, see the README)
 * must sign every billing record and event record. The format is AEAT's: "XAdES Enveloped Signature", class EPES with
 * the Spanish government's signature policy, RSA with SHA-256, over Canonical XML 1.0, as in AEAT's technical
 * specification "Especificaciones técnicas para generación de la firma electrónica de los registros de facturación".
 *
 * The signing certificate must be a qualified electronic signature certificate, in force, held by the taxpayer or by
 * someone authorised to act for them. VERI*FACTU systems need none of this.
 */

export const DsNamespace = 'http://www.w3.org/2000/09/xmldsig#'
export const XadesNamespace = 'http://uri.etsi.org/01903/v1.3.2#'

/** The signature policy AEAT requires (the Spanish government's "política de firma", annex 1) */
export const SignaturePolicy = {
  identifier: 'urn:oid:2.16.724.1.3.1.1.2.1.9',
  url: 'https://sede.administracion.gob.es/politica_de_firma_anexo_1.pdf',
  /** SHA-1 of the policy document, as fixed by the policy itself (this is not the algorithm used to sign) */
  hashAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  digestValue: 'G7roucf600+f03r/o0bAOQ6WAs0='
} as const

const C14n = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const RsaSha256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const Sha256 = 'http://www.w3.org/2001/04/xmlenc#sha256'
const EnvelopedSignature = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'

/** Whoever holds the private key and certificate, and can sign with them. Implement it to sign with a smart card or a key service. */
export interface RecordSigner {
  /** DER-encoded certificates: the signing certificate first, then the authorities that issued it (nearest first) */
  certificates: Buffer[]
  /** Signs `data` with RSA PKCS#1 v1.5 and SHA-256 (`RSASSA-PKCS1-v1_5` / `rsa-sha256`) */
  sign(data: Buffer): Promise<Buffer>
}

/** A signer from a PKCS#12 bundle or a PEM certificate and key, the same `ClientCertificate` the client uses */
export function createSigner(certificate: ClientCertificate): RecordSigner {
  if (certificate.pfx) {
    const { chain, privateKeyPem } = openPkcs12(certificate.pfx, certificate.passphrase)
    if (!privateKeyPem) throw new VerifactuConfigurationError('The PKCS#12 bundle has no private key to sign with')
    const certificates = chain.map((cert) => Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'))
    return signerFor(certificates, crypto.createPrivateKey(privateKeyPem))
  }
  if (!certificate.cert || !certificate.key) {
    throw new VerifactuConfigurationError('Signing needs a PKCS#12 bundle (pfx) or a PEM certificate and key')
  }
  const blocks = String(certificate.cert).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
  if (!blocks) throw new VerifactuConfigurationError('The PEM certificate holds no certificate')
  try {
    const certificates = blocks.map((block) => new X509Certificate(block).raw)
    return signerFor(certificates, crypto.createPrivateKey({ key: certificate.key, passphrase: certificate.passphrase }))
  }
  catch (error) {
    if (error instanceof VerifactuConfigurationError) throw error
    throw new VerifactuConfigurationError(`The signing certificate or key could not be read: ${(error as Error).message}`)
  }
}

function signerFor(certificates: Buffer[], key: KeyObject): RecordSigner {
  if (key.asymmetricKeyType !== 'rsa') throw new VerifactuConfigurationError('AEAT requires an RSA key to sign records')
  if (!new X509Certificate(certificates[0]).checkPrivateKey(key)) {
    throw new VerifactuConfigurationError('The private key does not belong to the signing certificate')
  }
  return { certificates, sign: async (data) => crypto.sign('sha256', data, key) }
}

export interface SignXmlOptions {
  /** The closing tag of the element the signature goes inside (as its last child), e.g. `</sum1:RegistroAlta>` */
  insertBefore: string
  /** When the signature is made (default now) */
  signingTime?: Date
  /** The signature's `Id` (default: a new random one) */
  id?: string
}

const sha256Base64 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('base64')

/** An issuer name the way XAdES writes it (RFC 2253: most specific first, `cn=...,o=...,c=ES`) */
function issuerName(certificate: X509Certificate): string {
  return certificate.issuer.split('\n')
    .map((line) => {
      const at = line.indexOf('=')
      return `${line.slice(0, at)}=${line.slice(at + 1).replace(/([,+"\\<>;])/g, '\\$1')}`
    })
    .reverse()
    .join(',')
}

function signedPropertiesXml(id: string, signer: RecordSigner, signingTime: Date): string {
  const certs = signer.certificates.map((der) => {
    const certificate = new X509Certificate(der)
    return `<xades:Cert><xades:CertDigest><ds:DigestMethod Algorithm="${Sha256}"/><ds:DigestValue>${sha256Base64(der)}</ds:DigestValue></xades:CertDigest>`
      + `<xades:IssuerSerial><ds:X509IssuerName>${escapeXml(issuerName(certificate))}</ds:X509IssuerName><ds:X509SerialNumber>${BigInt(`0x${certificate.serialNumber}`).toString()}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert>`
  }).join('')

  return `<xades:SignedProperties Id="${id}-signedprops"><xades:SignedSignatureProperties>`
    + `<xades:SigningTime>${formatTimestamp(signingTime)}</xades:SigningTime>`
    + `<xades:SigningCertificate>${certs}</xades:SigningCertificate>`
    + `<xades:SignaturePolicyIdentifier><xades:SignaturePolicyId><xades:SigPolicyId><xades:Identifier>${SignaturePolicy.identifier}</xades:Identifier><xades:Description/></xades:SigPolicyId>`
    + `<xades:SigPolicyHash><ds:DigestMethod Algorithm="${SignaturePolicy.hashAlgorithm}"/><ds:DigestValue>${SignaturePolicy.digestValue}</ds:DigestValue></xades:SigPolicyHash>`
    + `<xades:SigPolicyQualifiers><xades:SigPolicyQualifier><xades:SPURI>${SignaturePolicy.url}</xades:SPURI></xades:SigPolicyQualifier></xades:SigPolicyQualifiers></xades:SignaturePolicyId></xades:SignaturePolicyIdentifier>`
    + '</xades:SignedSignatureProperties>'
    + `<xades:SignedDataObjectProperties><xades:DataObjectFormat ObjectReference="#${id}-ref0"><xades:ObjectIdentifier><xades:Identifier>urn:oid:1.2.840.10003.5.109.10</xades:Identifier><xades:Description/></xades:ObjectIdentifier>`
    + '<xades:MimeType>text/xml</xades:MimeType><xades:Encoding>UTF-8</xades:Encoding></xades:DataObjectFormat></xades:SignedDataObjectProperties>'
    + '</xades:SignedProperties>'
}

function keyInfoXml(signer: RecordSigner): string {
  const leaf = new X509Certificate(signer.certificates[0])
  const jwk = leaf.publicKey.export({ format: 'jwk' }) as { n: string, e: string }
  const base64 = (value: string) => Buffer.from(value, 'base64url').toString('base64')
  return `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${signer.certificates[0].toString('base64')}</ds:X509Certificate></ds:X509Data>`
    + `<ds:KeyValue><ds:RSAKeyValue><ds:Modulus>${base64(jwk.n)}</ds:Modulus><ds:Exponent>${base64(jwk.e)}</ds:Exponent></ds:RSAKeyValue></ds:KeyValue></ds:KeyInfo>`
}

/**
 * Signs a standalone XML document (declarations of every namespace on its root) and returns the `ds:Signature` element
 * as XML text, to be placed as the last child of the element named by `insertBefore`. The document must not contain a
 * signature yet. The signature covers the whole document, and the signed properties (time, certificate, policy).
 */
export async function signXml(xml: string, signer: RecordSigner, options: SignXmlOptions): Promise<string> {
  const id = options.id ?? `xmldsig-${crypto.randomUUID()}`
  const signedProperties = signedPropertiesXml(id, signer, options.signingTime ?? new Date())
  const keyInfo = keyInfoXml(signer)

  const build = (referenceDigest: string, propertiesDigest: string, signatureValue: string): string =>
    `<ds:Signature xmlns:ds="${DsNamespace}" Id="${id}"><ds:SignedInfo>`
    + `<ds:CanonicalizationMethod Algorithm="${C14n}"/><ds:SignatureMethod Algorithm="${RsaSha256}"/>`
    + `<ds:Reference Id="${id}-ref0" URI=""><ds:Transforms><ds:Transform Algorithm="${EnvelopedSignature}"/></ds:Transforms><ds:DigestMethod Algorithm="${Sha256}"/><ds:DigestValue>${referenceDigest}</ds:DigestValue></ds:Reference>`
    + `<ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${id}-signedprops"><ds:Transforms><ds:Transform Algorithm="${C14n}"/></ds:Transforms><ds:DigestMethod Algorithm="${Sha256}"/><ds:DigestValue>${propertiesDigest}</ds:DigestValue></ds:Reference>`
    + `</ds:SignedInfo><ds:SignatureValue Id="${id}-sigvalue">${signatureValue}</ds:SignatureValue>${keyInfo}`
    + `<ds:Object><xades:QualifyingProperties xmlns:xades="${XadesNamespace}" xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#" Target="#${id}">${signedProperties}</xades:QualifyingProperties></ds:Object></ds:Signature>`

  // Each digest is taken in the context it will have in the finished document, because Canonical XML of a part of a
  // document includes the namespaces in scope from the elements around it
  const embed = (signature: string) => parseXml(insertBeforeClosing(xml, options.insertBefore, signature))

  const referenceDigest = sha256Base64(canonicalize(parseXml(xml)))
  const withProperties = embed(build('', '', ''))
  const propertiesDigest = sha256Base64(canonicalize(findById(withProperties, `${id}-signedprops`)!))

  const withSignedInfo = embed(build(referenceDigest, propertiesDigest, ''))
  const signedInfo = findElement(withSignedInfo, DsNamespace, 'SignedInfo')!
  const signatureValue = (await signer.sign(Buffer.from(canonicalize(signedInfo), 'utf8'))).toString('base64')

  return build(referenceDigest, propertiesDigest, signatureValue)
}

/**
 * Signs a billing record and returns it with its `signature` set (the record is not changed otherwise: the hash does
 * not cover the signature). Sign each record once, right after creating it, before storing or sending it.
 */
export async function signRecord<R extends BillingRecord>(record: R, signer: RecordSigner, options: Pick<SignXmlOptions, 'signingTime' | 'id'> = {}): Promise<R> {
  const [xml, closing] = record.kind === 'alta'
    ? [invoiceRecordXml(record, { standalone: true, unsigned: true }), '</sum1:RegistroAlta>']
    : [cancellationRecordXml(record, { standalone: true, unsigned: true }), '</sum1:RegistroAnulacion>']
  const signature = await signXml(xml, signer, { ...options, insertBefore: closing })
  return { ...record, signature }
}

/** Signs an event record and returns it with its `signature` set. Sign each event once, right after creating it. */
export async function signEventRecord(record: EventRecord, signer: RecordSigner, options: Pick<SignXmlOptions, 'signingTime' | 'id'> = {}): Promise<EventRecord> {
  const signature = await signXml(eventRecordXml(record, { unsigned: true }), signer, { ...options, insertBefore: '</sf:Evento>' })
  return { ...record, signature }
}
