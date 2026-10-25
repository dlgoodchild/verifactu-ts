import { VerifactuValidationError } from '~/errors'
import { afterRejection, asAmendment, cancellationAfterRejection, createCancellationRecord, createInvoiceRecord } from '~/record'
import { chainLinkOf } from '~/hash'
import { AeatExamples, cancellationInput, invoiceInput, IssuerNif } from '@/helper/verifactu.helper'

describe('createInvoiceRecord', () => {
  test('writes every value as AEAT wants it and works out the totals when left out', () => {
    const record = createInvoiceRecord(invoiceInput({
      breakdown: [
        { regimeKey: '01', qualification: 'S1', taxRate: 21, taxableBase: 100, taxAmount: 21 },
        { regimeKey: '01', qualification: 'S1', taxRate: '4.00', taxableBase: '10', taxAmount: '0.4' }
      ]
    }))

    expect(record.breakdown).toEqual([
      { regimeKey: '01', qualification: 'S1', taxRate: '21', taxableBase: '100.00', taxAmount: '21.00' },
      { regimeKey: '01', qualification: 'S1', taxRate: '4', taxableBase: '10.00', taxAmount: '0.40' }
    ])
    expect(record.totalTax).toBe('21.40')
    expect(record.totalAmount).toBe('131.40')
    expect(record.chaining).toEqual({ first: true })
    expect(record.hashType).toBe('01')
    expect(record.hash).toMatch(/^[0-9A-F]{64}$/)
  })

  test('uses the totals given, rather than working them out', () => {
    const record = createInvoiceRecord(invoiceInput({ totalTax: 12.35, totalAmount: '123.45' }))

    expect(record.totalTax).toBe('12.35')
    expect(record.totalAmount).toBe('123.45')
  })

  test('counts not-subject and exempt lines in the total but not in the tax', () => {
    const record = createInvoiceRecord(invoiceInput({
      invoiceType: 'F2',
      recipients: undefined,
      breakdown: [{ regimeKey: '17', qualification: 'N2', taxableBase: '50' }, { exemption: 'E1', taxableBase: '10.50' }]
    }))

    expect(record.totalTax).toBe('0.00')
    expect(record.totalAmount).toBe('60.50')
  })

  test('chains to the previous record, or starts the chain', () => {
    const first = createInvoiceRecord(invoiceInput())
    const second = createInvoiceRecord(invoiceInput({ id: { issuerNif: IssuerNif, number: AeatExamples.second.number, issueDate: '2024-01-01' }, generatedAt: AeatExamples.second.generatedAt }), chainLinkOf(first))

    expect(first.chaining).toEqual({ first: true })
    expect(second.chaining).toEqual({ previous: chainLinkOf(first) })
  })

  test('trims the text, so the hash is of what is sent', () => {
    const record = createInvoiceRecord(invoiceInput({ id: { issuerNif: ` ${IssuerNif} `, number: ' 12345678/G33 ', issueDate: '2024-01-01' }, issuerName: '  Dave  ', description: ' Subscription ', externalRef: ' ref ' }))

    expect(record.id.number).toBe('12345678/G33')
    expect(record.id.issuerNif).toBe(IssuerNif)
    expect(record.issuerName).toBe('Dave')
    expect(record.description).toBe('Subscription')
    expect(record.externalRef).toBe('ref')
    expect(record.hash).toBe(AeatExamples.first.hash)
  })

  test('writes a Date in Spanish time with its offset', () => {
    const record = createInvoiceRecord(invoiceInput({ generatedAt: new Date('2024-07-01T17:20:30Z') }))

    expect(record.generatedAt).toBe('2024-07-01T19:20:30+02:00')
  })

  test('keeps the optional parts it is given: corrective details, a foreign recipient, a third party', () => {
    const record = createInvoiceRecord(invoiceInput({
      invoiceType: 'R1',
      rectification: 'S',
      rectifiedInvoices: [{ issuerNif: IssuerNif, number: ' 1 ', issueDate: '2023-12-01' }],
      rectifiedAmounts: { base: 100, tax: 21 },
      recipients: [{ name: ' Kunde GmbH ', otherId: { countryCode: 'DE', type: '02', id: ' DE123456789 ' } }],
      thirdParty: { name: 'Gestoría', nif: 'B12345674' },
      issuedBy: 'T',
      operationDate: '2023-12-31',
      externalRef: 'x'
    }))

    expect(record.rectifiedInvoices).toEqual([{ issuerNif: IssuerNif, number: '1', issueDate: '2023-12-01' }])
    expect(record.rectifiedAmounts).toEqual({ base: '100.00', tax: '21.00' })
    expect(record.recipients).toEqual([{ name: 'Kunde GmbH', otherId: { countryCode: 'DE', type: '02', id: 'DE123456789' } }])
    expect(record.thirdParty).toEqual({ name: 'Gestoría', nif: 'B12345674' })
    expect(record.issuedBy).toBe('T')
    expect(record.operationDate).toBe('2023-12-31')
  })

  test('throws with every problem found when a value cannot be written', () => {
    const attempt = () => createInvoiceRecord(invoiceInput({
      breakdown: [{ qualification: 'S1', taxRate: 'abc', taxableBase: '1.234' }],
      generatedAt: 'yesterday',
      id: { issuerNif: IssuerNif, number: '1', issueDate: '2024-02-30' }
    }))

    expect(attempt).toThrow(VerifactuValidationError)
    try {
      attempt()
    }
    catch (error) {
      const paths = (error as VerifactuValidationError).issues.map((issue) => issue.path)
      expect(paths).toEqual(expect.arrayContaining(['breakdown[0].taxRate', 'breakdown[0].taxableBase', 'generatedAt', 'id.issueDate']))
    }
  })

  test('throws when the record would break the schema, unless asked not to check', () => {
    const tooLong = invoiceInput({ description: 'x'.repeat(501) })

    expect(() => createInvoiceRecord(tooLong)).toThrow('description')
    expect(createInvoiceRecord(tooLong, null, { validate: false }).description).toHaveLength(501)
  })
})

describe('createCancellationRecord', () => {
  test('cancels the record of an invoice, chained to the one before', () => {
    const first = createInvoiceRecord(invoiceInput())
    const record = createCancellationRecord(cancellationInput({ id: first.id, generatedBy: 'E' }), chainLinkOf(first))

    expect(record.kind).toBe('anulacion')
    expect(record.id).toEqual(first.id)
    expect(record.chaining).toEqual({ previous: chainLinkOf(first) })
    expect(record.generatedBy).toBe('E')
    expect(record.hash).toMatch(/^[0-9A-F]{64}$/)
  })

  test('keeps the details of who generated it and why', () => {
    const record = createCancellationRecord(cancellationInput({
      withoutPreviousRecord: true, previousRejection: 'N', generatedBy: 'T', generator: { name: 'Gestoría', nif: 'B12345674' }, externalRef: ' r '
    }))

    expect(record).toMatchObject({ withoutPreviousRecord: true, previousRejection: 'N', generatedBy: 'T', generator: { name: 'Gestoría', nif: 'B12345674' }, externalRef: 'r' })
  })

  test('refuses a date that does not exist', () => {
    expect(() => createCancellationRecord(cancellationInput({ id: { issuerNif: IssuerNif, number: '1', issueDate: '2024-13-01' } }))).toThrow(VerifactuValidationError)
  })
})

describe('corrections', () => {
  test('an amendment of an accepted record is marked Subsanacion S, and is a new record with its own hash', () => {
    const original = createInvoiceRecord(invoiceInput())
    const amended = createInvoiceRecord(asAmendment(invoiceInput({ description: 'Subscription, corrected', generatedAt: AeatExamples.second.generatedAt })), chainLinkOf(original))

    expect(amended.amendment).toBe(true)
    expect(amended.previousRejection).toBe('N')
    expect(amended.id).toEqual(original.id)
    expect(amended.hash).not.toBe(original.hash)
    expect(amended.chaining).toEqual({ previous: chainLinkOf(original) })
  })

  test('redoing a rejected alta is marked Subsanacion S and RechazoPrevio X', () => {
    const record = createInvoiceRecord(afterRejection(invoiceInput()))

    expect(record).toMatchObject({ amendment: true, previousRejection: 'X' })
  })

  test('redoing a rejected cancellation is marked RechazoPrevio S', () => {
    expect(createCancellationRecord(cancellationAfterRejection(cancellationInput()))).toMatchObject({ previousRejection: 'S' })
  })

  test('an amendment keeps an X given before', () => {
    expect(asAmendment({ ...invoiceInput(), previousRejection: 'X' }).previousRejection).toBe('X')
  })
})
