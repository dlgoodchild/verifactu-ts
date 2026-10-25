import { generateKeyPairSync } from 'crypto'
import fs from 'fs'
import forge from 'node-forge'
import path from 'path'
import { VerifactuConfigurationError } from '~/errors'
import { chainLinkOf } from '~/hash'
import { createCancellationRecord, createInvoiceRecord } from '~/record'
import { createSigner, signRecord, signXml, SignaturePolicy } from '~/sign'
import { verifySignature } from '~/verify-signature'
import { validateCancellationRecord, validateInvoiceRecord } from '~/validate'
import { buildSubmissionXml, cancellationRecordXml, invoiceRecordXml } from '~/xml'
import { VerifactuClient } from '~/client'
import { cancellationInput, FakeTransport, header, invoiceInput, makeSigningCertificate, ok, pfxOf, submissionReplyXml } from '@/helper/verifactu.helper'

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

const derOf = (cert: forge.pki.Certificate) => Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary')

const { authority, leaf } = makeSigningCertificate()
const pfx = pfxOf(leaf, [authority.cert], 'secret')
const signer = createSigner({ pfx, passphrase: 'secret' })

describe('verifySignature, against AEAT\'s own signed example', () => {
  test('accepts the signature AEAT published (digests and the RSA signature value all check out)', () => {
    const result = verifySignature(fixture('aeat-record-signed.xml'))

    expect(result.problems).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.signingTime).toBe('2025-02-03T16:15:55.105+01:00')
    expect(result.signerSubject).toContain('CERTIFICADO UNO TELEMATICAS')
  })

  test('rejects it once the signed record is changed', () => {
    const changed = fixture('aeat-record-signed.xml').replace('<sum1:ImporteTotal>241.4</sum1:ImporteTotal>', '<sum1:ImporteTotal>1.4</sum1:ImporteTotal>')

    const result = verifySignature(changed)

    expect(result.valid).toBe(false)
    expect(result.problems.join(' ')).toContain('has changed')
  })

  test('rejects it once the signed properties (certificate, time, policy) are changed', () => {
    const changed = fixture('aeat-record-signed.xml').replace('2025-02-03T16:15:55.105+01:00', '2026-02-03T16:15:55.105+01:00')

    expect(verifySignature(changed).valid).toBe(false)
  })

  test('rejects it once the signature value is changed', () => {
    const changed = fixture('aeat-record-signed.xml').replace('ruvN8lGx0knqU7CIZmi82ez7kmAsgt7LPE1LW2j13kA5', 'ruvN8lGx0knqU7CIZmi82ez7kmAsgt7LPE1LW2j13kA6')

    const result = verifySignature(changed)

    expect(result.valid).toBe(false)
    expect(result.problems.join(' ')).toContain('signature value does not match')
  })

  test('says so when there is no signature, or the XML cannot be read', () => {
    expect(verifySignature(fixture('aeat-record-unsigned.xml'))).toMatchObject({ valid: false, problems: ['There is no signature in the document'] })
    expect(verifySignature('<a>').valid).toBe(false)
  })
})

describe('createSigner', () => {
  test('reads a PKCS#12 bundle: the signing certificate first, then its authority', () => {
    expect(signer.certificates).toHaveLength(2)
    expect(signer.certificates[0].equals(derOf(leaf.cert))).toBe(true)
    expect(signer.certificates[1].equals(derOf(authority.cert))).toBe(true)
  })

  test('reads PEM, including a chain in one text', () => {
    const fromPem = createSigner({ cert: `${leaf.pem}${authority.pem}`, key: leaf.keyPem })

    expect(fromPem.certificates).toHaveLength(2)
  })

  test('accepts the bundle as base64 text', () => {
    expect(createSigner({ pfx: pfx.toString('base64'), passphrase: 'secret' }).certificates).toHaveLength(2)
  })

  test('refuses a wrong password, no key, a key from another certificate, and a key that is not RSA', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

    expect(() => createSigner({ pfx, passphrase: 'wrong' })).toThrow(VerifactuConfigurationError)
    expect(() => createSigner({ cert: leaf.pem })).toThrow('PKCS#12 bundle (pfx) or a PEM certificate and key')
    expect(() => createSigner({ cert: leaf.pem, key: other })).toThrow('does not belong')
    expect(() => createSigner({ cert: leaf.pem, key: ec })).toThrow('RSA')
    expect(() => createSigner({ cert: 'nothing', key: leaf.keyPem })).toThrow('holds no certificate')
  })
})

describe('signRecord', () => {
  const record = () => createInvoiceRecord(invoiceInput())

  test('adds a signature that verifies, and changes nothing else (the hash does not cover it)', async () => {
    const original = record()

    const signed = await signRecord(original, signer)

    expect(signed.signature).toMatch(/^<ds:Signature /)
    expect(signed.hash).toBe(original.hash)
    expect({ ...signed, signature: undefined }).toEqual({ ...original, signature: undefined })
    expect(verifySignature(invoiceRecordXml(signed, { standalone: true })).problems).toEqual([])
  })

  test('is XAdES-EPES: the AGE policy, SHA-256, C14N 1.0, enveloped, with the certificates and the signing time', async () => {
    const signed = await signRecord(record(), signer, { signingTime: new Date('2024-03-01T10:00:00Z') })

    expect(signed.signature).toContain('Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"')
    expect(signed.signature).toContain('Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"')
    expect(signed.signature).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"')
    expect(signed.signature).toContain(`<xades:Identifier>${SignaturePolicy.identifier}</xades:Identifier>`)
    expect(signed.signature).toContain(`<ds:DigestValue>${SignaturePolicy.digestValue}</ds:DigestValue>`)
    expect(signed.signature).toContain(`<xades:SPURI>${SignaturePolicy.url}</xades:SPURI>`)
    expect(signed.signature).toContain('<xades:SigningTime>2024-03-01T11:00:00+01:00</xades:SigningTime>')
    expect(signed.signature?.match(/<xades:Cert>/g)).toHaveLength(2)
    expect(signed.signature).toContain('<ds:X509IssuerName>')
    expect(verifySignature(invoiceRecordXml(signed, { standalone: true })).signingTime).toBe('2024-03-01T11:00:00+01:00')
  })

  test('puts the signature last inside the record, and leaves it out when asked', async () => {
    const signed = await signRecord(record(), signer)

    expect(invoiceRecordXml(signed)).toMatch(/<\/sum1:Huella><ds:Signature .*<\/ds:Signature><\/sum1:RegistroAlta>$/)
    expect(invoiceRecordXml(signed, { unsigned: true })).toMatch(/<\/sum1:Huella><\/sum1:RegistroAlta>$/)
    expect(invoiceRecordXml(signed, { standalone: true })).toMatch(/^<sum1:RegistroAlta xmlns:sum1="https:\/\/[^"]+SuministroInformacion\.xsd">/)
  })

  test('detects a change to the record after signing', async () => {
    const signed = await signRecord(record(), signer)
    const tampered = invoiceRecordXml(signed, { standalone: true }).replace('<sum1:DescripcionOperacion>Subscription', '<sum1:DescripcionOperacion>Changed')

    const result = verifySignature(tampered)

    expect(result.valid).toBe(false)
    expect(result.problems.join(' ')).toContain('has changed')
  })

  test('detects a signature made over another record being moved onto this one', async () => {
    const one = await signRecord(record(), signer)
    const other = createInvoiceRecord(invoiceInput({ description: 'Another invoice' }))
    const moved = invoiceRecordXml({ ...other, signature: one.signature }, { standalone: true })

    expect(verifySignature(moved).valid).toBe(false)
  })

  test('signs a cancellation record too', async () => {
    const cancelled = createCancellationRecord(cancellationInput(), chainLinkOf(record()))

    const signed = await signRecord(cancelled, signer)

    expect(verifySignature(cancellationRecordXml(signed, { standalone: true })).problems).toEqual([])
    expect(cancellationRecordXml(signed)).toMatch(/<\/ds:Signature><\/sum1:RegistroAnulacion>$/)
  })

  test('works with a PEM key as well as a bundle, and with text that needs escaping', async () => {
    const pem = createSigner({ cert: leaf.pem, key: leaf.keyPem })
    const signed = await signRecord(createInvoiceRecord(invoiceInput({ description: 'Q&A <training> "pack" Ñandú €' })), pem)

    expect(verifySignature(invoiceRecordXml(signed, { standalone: true })).problems).toEqual([])
  })

  test('produces a record the validation accepts, and refuses text that is not a signature', async () => {
    const signed = await signRecord(record(), signer)

    expect(validateInvoiceRecord(signed)).toEqual([])
    expect(validateCancellationRecord({ ...createCancellationRecord(cancellationInput()), signature: '<x/>' }).map((issue) => issue.code)).toContain('invalid-signature')
  })

  test('is carried in a submission, inside its record', async () => {
    const signed = await signRecord(record(), signer)

    const xml = buildSubmissionXml(header, [signed])

    expect(xml).toContain('<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"')
    expect(xml).toMatch(/<\/ds:Signature><\/sum1:RegistroAlta><\/sum:RegistroFactura>/)
  })
})

describe('signXml', () => {
  test('signs any standalone document and puts the signature where asked', async () => {
    const xml = '<r:Doc xmlns:r="urn:r"><r:A>1</r:A></r:Doc>'

    const signature = await signXml(xml, signer, { insertBefore: '</r:Doc>', id: 'sig-1' })

    expect(signature).toContain('Id="sig-1"')
    expect(verifySignature(xml.replace('</r:Doc>', `${signature}</r:Doc>`)).problems).toEqual([])
  })
})

describe('the client, for a system that sends records only when AEAT asks', () => {
  test('warns about a record that is not signed, and not about one that is', async () => {
    const client = new VerifactuClient({ environment: 'test', mode: 'requirement', transport: new FakeTransport([ok(submissionReplyXml())]) })
    const unsigned = createInvoiceRecord(invoiceInput())
    const signed = await signRecord(unsigned, signer)

    expect(client.check({ ...header, requirement: { reference: 'REQ-1' } }, [unsigned]).map((issue) => issue.code)).toContain('signature-expected')
    expect(client.check({ ...header, requirement: { reference: 'REQ-1' } }, [signed]).map((issue) => issue.code)).not.toContain('signature-expected')
  })

  test('does not mind in the normal VERI*FACTU way, where records are not signed', () => {
    const client = new VerifactuClient({ environment: 'test', transport: new FakeTransport([ok(submissionReplyXml())]) })

    expect(client.check(header, [createInvoiceRecord(invoiceInput())]).map((issue) => issue.code)).not.toContain('signature-expected')
  })
})
