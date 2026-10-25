import {
  calculateRecordHash, cancellationHashInput, chainLinkOf, computeCancellationHash, computeEventHash, computeInvoiceHash, eventHashInput, invoiceHashInput,
  sha256Hex, verifyChain, verifyRecordHash
} from '~/hash'
import { createCancellationRecord, createInvoiceRecord } from '~/record'
import { AeatExamples, cancellationInput, invoiceInput, IssuerNif } from '@/helper/verifactu.helper'

/** The three worked examples in AEAT's hash specification v0.1.2, section 6 */
describe('the hash, against AEAT\'s own examples', () => {
  test('example 1: the first record of a chain has an empty previous hash', () => {
    const fields = { issuerNif: IssuerNif, number: '12345678/G33', issueDate: '01-01-2024', invoiceType: 'F1', totalTax: '12.35', totalAmount: '123.45', previousHash: '', generatedAt: '2024-01-01T19:20:30+01:00' }

    expect(invoiceHashInput(fields)).toBe(
      'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00'
    )
    expect(computeInvoiceHash(fields)).toBe(AeatExamples.first.hash)
  })

  test('example 2: the next record includes the previous record\'s hash', () => {
    const fields = {
      issuerNif: IssuerNif, number: '12345679/G34', issueDate: '01-01-2024', invoiceType: 'F1', totalTax: '12.35', totalAmount: '123.45',
      previousHash: AeatExamples.first.hash, generatedAt: '2024-01-01T19:20:35+01:00'
    }

    expect(computeInvoiceHash(fields)).toBe(AeatExamples.second.hash)
  })

  test('example 3: a cancellation uses the "Anulada" field names and fewer fields', () => {
    const fields = { issuerNif: IssuerNif, number: '12345679/G34', issueDate: '01-01-2024', previousHash: AeatExamples.second.hash, generatedAt: '2024-01-01T19:20:40+01:00' }

    expect(cancellationHashInput(fields)).toBe(
      'IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34&FechaExpedicionFacturaAnulada=01-01-2024&Huella=F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97&FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00'
    )
    expect(computeCancellationHash(fields)).toBe(AeatExamples.cancellation.hash)
  })
})

describe('the hash input', () => {
  test('trims the ends of every value, as AEAT does with the XML', () => {
    const fields = { issuerNif: ' 89890001K ', number: '  12345678 / G33  ', issueDate: '01-01-2024', invoiceType: 'F1', totalTax: '12.35', totalAmount: '123.45', generatedAt: '2024-01-01T19:20:30+01:00' }

    expect(invoiceHashInput(fields)).toContain('IDEmisorFactura=89890001K&NumSerieFactura=12345678 / G33&')
  })

  test('writes a missing value as the name and an equals sign', () => {
    expect(invoiceHashInput({ issuerNif: IssuerNif, number: '1', issueDate: '01-01-2024', invoiceType: 'F1', totalTax: '0.00', totalAmount: '1.00', generatedAt: 'x' })).toContain('&Huella=&')
  })

  test('is the same text whatever the case of the input hex, and always upper case', () => {
    expect(sha256Hex('abc')).toBe('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD')
    expect(sha256Hex('abc')).toMatch(/^[0-9A-F]{64}$/)
  })

  test('encodes in UTF-8, so non-ASCII text changes the hash predictably', () => {
    expect(sha256Hex('Ñandú')).toBe(sha256Hex(Buffer.from('Ñandú', 'utf8').toString('utf8')))
    expect(sha256Hex('Ñandú')).not.toBe(sha256Hex('Nandu'))
  })
})

describe('the event hash', () => {
  const fields = {
    producerNif: '89890001K', systemId: 'EX', version: '1.0', installationNumber: '1', taxpayerNif: '89890002E', eventType: '01', previousHash: '', generatedAt: '2024-01-01T19:20:30+01:00'
  }

  test('names the fields as AEAT\'s specification does, with the NIF twice', () => {
    expect(eventHashInput(fields)).toBe('NIF=89890001K&ID=&IdSistemaInformatico=EX&Version=1.0&NumeroInstalacion=1&NIF=89890002E&TipoEvento=01&HuellaEvento=&FechaHoraHusoGenEvento=2024-01-01T19:20:30+01:00')
  })

  test('puts the other ID in place of the NIF when the producer has no Spanish NIF', () => {
    expect(eventHashInput({ ...fields, producerNif: undefined, producerOtherId: 'DE123' })).toContain('NIF=&ID=DE123&')
  })

  test('is a SHA-256 of that text', () => {
    expect(computeEventHash(fields)).toBe(sha256Hex(eventHashInput(fields)))
  })
})

describe('records and the chain', () => {
  const first = () => createInvoiceRecord(invoiceInput())
  const second = () => createInvoiceRecord(invoiceInput({ id: { issuerNif: IssuerNif, number: AeatExamples.second.number, issueDate: '2024-01-01' }, generatedAt: AeatExamples.second.generatedAt }), chainLinkOf(first()))
  const third = () => createCancellationRecord(cancellationInput(), chainLinkOf(second()))

  test('a built record has the hash AEAT\'s examples give', () => {
    expect(first().hash).toBe(AeatExamples.first.hash)
    expect(second().hash).toBe(AeatExamples.second.hash)
    expect(third().hash).toBe(AeatExamples.cancellation.hash)
  })

  test('a record verifies against its own content, and not once changed', () => {
    const record = first()

    expect(verifyRecordHash(record)).toBe(true)
    expect(verifyRecordHash({ ...record, totalAmount: '123.46' })).toBe(false)
    expect(verifyRecordHash({ ...record, hashType: '99' as never })).toBe(false)
    expect(calculateRecordHash(record)).toBe(record.hash)
  })

  test('the link to a record carries its identity and hash', () => {
    expect(chainLinkOf(first())).toEqual({ issuerNif: IssuerNif, number: '12345678/G33', issueDate: '2024-01-01', hash: AeatExamples.first.hash })
  })

  test('a sound chain has no problems, from the start or continuing from an earlier record', () => {
    const a = first()
    const b = second()
    const c = third()

    expect(verifyChain([a, b, c])).toEqual([])
    expect(verifyChain([b, c], chainLinkOf(a))).toEqual([])
  })

  test('finds a changed record', () => {
    const problems = verifyChain([first(), { ...second(), totalAmount: '999.00' }])

    expect(problems).toEqual([expect.objectContaining({ index: 1, code: 'bad-hash' })])
  })

  test('finds a record that does not chain to the one before, and a missing or extra start', () => {
    const a = first()
    const c = third()

    expect(verifyChain([a, c]).map((problem) => problem.code)).toEqual(['bad-link'])
    expect(verifyChain([second()]).map((problem) => problem.code)).toEqual(['missing-first'])
    expect(verifyChain([a, a]).map((problem) => problem.code)).toEqual(['unexpected-first'])
    expect(verifyChain([a], chainLinkOf(first())).map((problem) => problem.code)).toEqual(['unexpected-first'])
  })

  test('finds a removed record in the middle', () => {
    expect(verifyChain([first(), third()]).map((problem) => problem.code)).toContain('bad-link')
  })
})
