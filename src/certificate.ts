import { X509Certificate } from 'crypto'
import forge from 'node-forge'
import { VerifactuConfigurationError } from '~/errors'
import type { ClientCertificate } from '~/transport'

/**
 * Reading facts about the client certificate, mainly when it expires. AEAT rejects requests made with an expired
 * certificate, so check this on a schedule and warn well before `notAfter`.
 */

export interface CertificateInfo {
  /** Who the certificate was issued to, e.g. `CN=NOMBRE APELLIDO - 12345678Z, SERIALNUMBER=IDCES-12345678Z, ...` */
  subject: string
  /** The common name (CN) of the subject, if it has one */
  commonName: string | null
  /** The name of the authority that issued it */
  issuer: string
  /** Hex, upper case */
  serialNumber: string
  notBefore: Date
  notAfter: Date
}

const Day = 24 * 60 * 60 * 1000

/** Reads the certificate that is used to authenticate, from a PKCS#12 bundle or a PEM certificate */
export function readCertificateInfo(certificate: ClientCertificate): CertificateInfo {
  if (certificate.pfx) return fromPkcs12(certificate.pfx, certificate.passphrase)
  if (certificate.cert) return fromPem(certificate.cert)
  throw new VerifactuConfigurationError('A client certificate needs either a PKCS#12 bundle (pfx) or a PEM certificate and key')
}

/** True once the certificate's last valid moment has passed */
export function isExpired(info: Pick<CertificateInfo, 'notAfter'>, now: Date = new Date()): boolean {
  return now.getTime() > info.notAfter.getTime()
}

/** Whole days left before it expires (rounded down); negative when it has expired */
export function daysUntilExpiry(info: Pick<CertificateInfo, 'notAfter'>, now: Date = new Date()): number {
  return Math.floor((info.notAfter.getTime() - now.getTime()) / Day)
}

/** True when it has expired or will within `days` days; use to raise a renewal warning */
export function expiresWithin(info: Pick<CertificateInfo, 'notAfter'>, days: number, now: Date = new Date()): boolean {
  return info.notAfter.getTime() - now.getTime() <= days * Day
}

function fromPem(cert: Buffer | string): CertificateInfo {
  try {
    const parsed = new X509Certificate(cert)
    return {
      subject: oneLine(parsed.subject),
      commonName: /^CN=(.*)$/m.exec(parsed.subject)?.[1] ?? null,
      issuer: oneLine(parsed.issuer),
      serialNumber: parsed.serialNumber.toUpperCase(),
      notBefore: new Date(parsed.validFrom),
      notAfter: new Date(parsed.validTo)
    }
  }
  catch (error) {
    throw new VerifactuConfigurationError(`The certificate could not be read: ${(error as Error).message}`)
  }
}

/** Node prints a subject one attribute per line; this is one line, comma separated */
const oneLine = (name: string): string => name.split('\n').join(', ')

/** What is inside a PKCS#12 bundle */
export interface Pkcs12Contents {
  /** The certificate the private key belongs to */
  leaf: forge.pki.Certificate
  /** `leaf` first, then the authorities that issued it, nearest first (only those that are in the bundle) */
  chain: forge.pki.Certificate[]
  /** The private key as PEM, or null if the bundle has none */
  privateKeyPem: string | null
}

/** Opens a PKCS#12 bundle (a Buffer, or base64 text) with its password. Throws `VerifactuConfigurationError` if it cannot. */
export function openPkcs12(pfx: Buffer | string, passphrase?: string): Pkcs12Contents {
  try {
    const der = typeof pfx === 'string' ? Buffer.from(pfx, 'base64') : pfx
    const bundle = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der.toString('binary')), passphrase ?? '')
    const certificates = (bundle.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
      .map((bag) => bag.cert)
      .filter((cert): cert is forge.pki.Certificate => !!cert)
    if (certificates.length === 0) throw new Error('the bundle holds no certificate')

    const leaf = pickLeaf(bundle, certificates)
    const chain = [leaf]
    for (let current = leaf; ;) {
      const parent = certificates.find((candidate) => !chain.includes(candidate) && candidate.issued(current))
      if (!parent) break
      chain.push(parent)
      current = parent
    }

    const keyBags = [
      ...(bundle.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
      ...(bundle.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])
    ]
    const key = keyBags[0]?.key
    return { leaf, chain, privateKeyPem: key ? forge.pki.privateKeyToPem(key) : null }
  }
  catch (error) {
    throw new VerifactuConfigurationError(`The PKCS#12 certificate could not be read (check the file and its password): ${(error as Error).message}`)
  }
}

function fromPkcs12(pfx: Buffer | string, passphrase?: string): CertificateInfo {
  const { leaf } = openPkcs12(pfx, passphrase)
  const name = (attributes: forge.pki.CertificateField[]) => attributes.map((attribute) => `${attribute.shortName ?? attribute.name}=${attribute.value}`).join(', ')
  return {
    subject: name(leaf.subject.attributes),
    commonName: (leaf.subject.getField('CN')?.value as string | undefined) ?? null,
    issuer: name(leaf.issuer.attributes),
    serialNumber: leaf.serialNumber.toUpperCase(),
    notBefore: leaf.validity.notBefore,
    notAfter: leaf.validity.notAfter
  }
}

/**
 * A bundle can also carry the issuing authorities' certificates. The one we want is the one the private key belongs to
 * (they share a local key id); failing that, the one that did not issue any of the others.
 */
function pickLeaf(bundle: forge.pkcs12.Pkcs12Pfx, certificates: forge.pki.Certificate[]): forge.pki.Certificate {
  const keyBags = [
    ...(bundle.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(bundle.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])
  ]
  const keyId = keyBags.map((bag) => localKeyId(bag.attributes))[0]
  if (keyId) {
    const certBags = bundle.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
    const match = certBags.find((bag) => localKeyId(bag.attributes) === keyId)
    if (match?.cert) return match.cert
  }
  return certificates.find((candidate) => !certificates.some((other) => other !== candidate && candidate.issued(other))) ?? certificates[0]
}

function localKeyId(attributes: forge.pkcs12.Bag['attributes'] | undefined): string | undefined {
  const value = attributes?.localKeyId?.[0]
  return typeof value === 'string' ? forge.util.bytesToHex(value) : undefined
}
