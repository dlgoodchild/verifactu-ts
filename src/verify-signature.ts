import crypto, { X509Certificate } from 'crypto'
import { canonicalize, findById, findElement, namespaceOf, parseXml, textOf, type XmlElement } from '~/c14n'
import { VerifactuError } from '~/errors'
import { DsNamespace, XadesNamespace } from '~/sign'

/**
 * Checking the signature in a signed record (a billing record or an event record) from its XML. This confirms the
 * signature is *mathematically sound*: the signed content has not changed since it was signed, and the signature was
 * made with the key of the certificate it carries. It does **not** decide whether to trust that certificate (issuer,
 * expiry, revocation); do that separately, e.g. with `readCertificateInfo`.
 */

export interface SignatureVerification {
  /** True when every digest and the signature value check out and nothing unsupported was found */
  valid: boolean
  /** What failed, in words; empty when valid */
  problems: string[]
  /** `SigningTime` from the signed properties */
  signingTime?: string
  /** The subject of the certificate that signed */
  signerSubject?: string
  /** The certificate that signed, when it could be read */
  certificate?: X509Certificate
}

const C14n = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const EnvelopedSignature = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'

const DigestAlgorithms: Record<string, string> = {
  'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1',
  'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512'
}

const SignatureAlgorithms: Record<string, string> = {
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'sha1',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'sha512'
}

const children = (element: XmlElement, local: string): XmlElement[] =>
  element.children.filter((child): child is XmlElement => child.kind === 'element' && child.local === local && namespaceOf(child) === DsNamespace)

const compact = (value: string): string => value.replace(/\s+/g, '')

const attribute = (element: XmlElement | undefined, name: string): string | undefined => element?.attributes.find((entry) => entry.local === name)?.value

/** Verifies the first signature in the XML document */
export function verifySignature(xml: string): SignatureVerification {
  const problems: string[] = []
  const result = (extra: Partial<SignatureVerification> = {}): SignatureVerification => ({ valid: problems.length === 0, problems, ...extra })

  let root: XmlElement
  try {
    root = parseXml(xml)
  }
  catch (error) {
    if (error instanceof VerifactuError) return { valid: false, problems: [error.message] }
    throw error
  }

  const signature = findElement(root, DsNamespace, 'Signature')
  const signedInfo = signature ? children(signature, 'SignedInfo')[0] : undefined
  if (!signature || !signedInfo) {
    problems.push('There is no signature in the document')
    return result()
  }

  if (attribute(children(signedInfo, 'CanonicalizationMethod')[0], 'Algorithm') !== C14n) {
    problems.push(`Only Canonical XML 1.0 (${C14n}) is supported`)
  }

  // Every reference's digest
  const references = children(signedInfo, 'Reference')
  let coversDocument = false
  for (const reference of references) {
    const uri = attribute(reference, 'URI') ?? ''
    const transforms = children(children(reference, 'Transforms')[0] ?? reference, 'Transform').map((transform) => attribute(transform, 'Algorithm'))
    const unsupported = transforms.filter((transform) => transform !== C14n && transform !== EnvelopedSignature)
    if (unsupported.length > 0) {
      problems.push(`Reference "${uri}" uses an unsupported transform: ${unsupported.join(', ')}`)
      continue
    }

    const target = uri === '' ? root : uri.startsWith('#') ? findById(root, uri.slice(1)) : null
    if (!target) {
      problems.push(`Reference "${uri}" points to nothing in the document`)
      continue
    }
    if (uri === '') coversDocument = true

    const algorithm = DigestAlgorithms[attribute(children(reference, 'DigestMethod')[0], 'Algorithm') ?? '']
    if (!algorithm) {
      problems.push(`Reference "${uri}" uses an unsupported digest algorithm`)
      continue
    }
    const enveloped = transforms.includes(EnvelopedSignature)
    const actual = crypto.createHash(algorithm).update(canonicalize(target, enveloped ? { exclude: signature } : {}), 'utf8').digest('base64')
    const expected = compact(textOf(children(reference, 'DigestValue')[0] ?? signature))
    if (actual !== expected) problems.push(`The content signed by reference "${uri}" has changed (its digest does not match)`)
  }
  if (!coversDocument) problems.push('The signature does not cover the whole document')

  // The signature itself
  const hash = SignatureAlgorithms[attribute(children(signedInfo, 'SignatureMethod')[0], 'Algorithm') ?? '']
  if (!hash) problems.push('The signature uses an unsupported algorithm')

  const keyInfo = children(signature, 'KeyInfo')[0]
  const certificateText = keyInfo ? compact(textOf(findElement(keyInfo, DsNamespace, 'X509Certificate') ?? keyInfo)) : ''
  let certificate: X509Certificate | undefined
  try {
    certificate = certificateText ? new X509Certificate(Buffer.from(certificateText, 'base64')) : undefined
  }
  catch {
    certificate = undefined
  }
  if (!certificate) problems.push('The signature carries no readable certificate')

  const signatureValue = children(signature, 'SignatureValue')[0]
  if (hash && certificate && signatureValue) {
    const valid = crypto.verify(hash, Buffer.from(canonicalize(signedInfo), 'utf8'), certificate.publicKey, Buffer.from(compact(textOf(signatureValue)), 'base64'))
    if (!valid) problems.push('The signature value does not match: the signed information was changed, or another key made it')
  }

  const signingTime = findElement(signature, XadesNamespace, 'SigningTime')
  return result({
    signingTime: signingTime ? textOf(signingTime).trim() : undefined,
    signerSubject: certificate?.subject.split('\n').join(', '),
    certificate
  })
}
