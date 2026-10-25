import { VerifactuValidationError } from '~/errors'
import { chainLinkOf } from '~/hash'
import { createCancellationRecord, createInvoiceRecord } from '~/record'
import { assertNoErrors, validateCancellationRecord, validateHeader, validateInvoiceRecord, validateSubmission } from '~/validate'
import type { InvoiceRecord, ValidationIssue } from '~/types'
import { AeatExamples, cancellationInput, header, invoiceInput, IssuerNif, system } from '@/helper/verifactu.helper'

const valid = () => createInvoiceRecord(invoiceInput())
const codes = (issues: ValidationIssue[], severity?: 'error' | 'warning') => issues.filter((issue) => !severity || issue.severity === severity).map((issue) => `${issue.code}@${issue.path}`)

/** Changes a record without re-hashing it; the hash check is ignored unless a test is about it */
const changed = (changes: Partial<InvoiceRecord>): InvoiceRecord => ({ ...valid(), ...changes })
const withoutHashWarning = (issues: ValidationIssue[]) => issues.filter((issue) => issue.code !== 'hash-mismatch')

describe('validateInvoiceRecord', () => {
  test('finds nothing wrong with a sound record', () => {
    expect(validateInvoiceRecord(valid())).toEqual([])
  })

  describe('errors: what AEAT\'s schema rejects', () => {
    test.each([
      ['a NIF that is not 9 characters', { id: { issuerNif: '123', number: '1', issueDate: '2024-01-01' } }, 'nif-length@id.issuerNif'],
      ['an empty invoice number', { id: { issuerNif: IssuerNif, number: '', issueDate: '2024-01-01' } }, 'required@id.number'],
      ['an invoice number over 60 characters', { id: { issuerNif: IssuerNif, number: 'x'.repeat(61), issueDate: '2024-01-01' } }, 'text-too-long@id.number'],
      ['a date that does not exist', { id: { issuerNif: IssuerNif, number: '1', issueDate: '2024-02-30' } }, 'invalid-date@id.issueDate'],
      ['an issuer name over 120 characters', { issuerName: 'x'.repeat(121) }, 'text-too-long@issuerName'],
      ['no issuer name', { issuerName: '' }, 'required@issuerName'],
      ['an empty description', { description: '' }, 'required@description'],
      ['a description over 500 characters', { description: 'x'.repeat(501) }, 'text-too-long@description'],
      ['an unknown invoice type', { invoiceType: 'F9' as never }, 'invalid-code@invoiceType'],
      ['an unknown rectification type', { rectification: 'X' as never }, 'invalid-code@rectification'],
      ['an external reference over 60 characters', { externalRef: 'x'.repeat(61) }, 'text-too-long@externalRef'],
      ['a billing agreement number over 15 characters', { billingAgreementNumber: 'x'.repeat(16) }, 'text-too-long@billingAgreementNumber'],
      ['an unreadable total', { totalAmount: '12,5' }, 'invalid-amount@totalAmount'],
      ['a time without an offset', { generatedAt: '2024-01-01T19:20:30' }, 'invalid-timestamp@generatedAt'],
      ['a hash that is not 64 upper-case hex characters', { hash: 'abc' }, 'invalid-hash@hash'],
      ['an unknown hash type', { hashType: '02' as never }, 'invalid-code@hashType'],
      ['no breakdown', { breakdown: [] }, 'required@breakdown']
    ])('%s', (_name, changes, expected) => {
      expect(codes(validateInvoiceRecord(changed(changes as Partial<InvoiceRecord>)), 'error')).toContain(expected)
    })

    test('more than 12 breakdown lines', () => {
      const line = { regimeKey: '01' as const, qualification: 'S1' as const, taxRate: '21', taxableBase: '1.00', taxAmount: '0.21' }

      expect(codes(validateInvoiceRecord(changed({ breakdown: Array.from({ length: 13 }, () => line) })), 'error')).toContain('too-many@breakdown')
    })

    test('a breakdown line with both a qualification and an exemption, or neither', () => {
      expect(codes(validateInvoiceRecord(changed({ breakdown: [{ qualification: 'S1', exemption: 'E1', taxableBase: '1.00' }] })), 'error')).toContain('qualification-choice@breakdown[0]')
      expect(codes(validateInvoiceRecord(changed({ breakdown: [{ taxableBase: '1.00' }] })), 'error')).toContain('qualification-choice@breakdown[0]')
    })

    test('unknown codes and unreadable amounts in a breakdown line', () => {
      const issues = codes(validateInvoiceRecord(changed({
        breakdown: [{ tax: '99' as never, regimeKey: '99' as never, qualification: 'S9' as never, taxRate: '1000', taxableBase: 'x', taxAmount: '1.234' }]
      })), 'error')

      expect(issues).toEqual(expect.arrayContaining([
        'invalid-code@breakdown[0].tax', 'invalid-code@breakdown[0].regimeKey', 'invalid-code@breakdown[0].qualification',
        'invalid-rate@breakdown[0].taxRate', 'invalid-amount@breakdown[0].taxableBase', 'invalid-amount@breakdown[0].taxAmount'
      ]))
    })

    test('a recipient with neither or both of a NIF and another ID', () => {
      expect(codes(validateInvoiceRecord(changed({ recipients: [{ name: 'A' }] })), 'error')).toContain('id-choice@recipients[0]')
      expect(codes(validateInvoiceRecord(changed({ recipients: [{ name: 'A', nif: 'A58818501', otherId: { type: '03', id: 'X' } }] })), 'error')).toContain('id-choice@recipients[0]')
    })

    test('a foreign ID with an unknown kind, too long an ID or an unknown country', () => {
      const issues = codes(validateInvoiceRecord(changed({ recipients: [{ name: 'A', otherId: { type: '09' as never, id: 'x'.repeat(21), countryCode: 'ZZ' } }] })), 'error')

      expect(issues).toEqual(expect.arrayContaining(['invalid-code@recipients[0].otherId.type', 'text-too-long@recipients[0].otherId.id', 'invalid-country@recipients[0].otherId.countryCode']))
    })

    test('a system block that is incomplete or too long', () => {
      const issues = codes(validateInvoiceRecord(changed({ system: { ...system, name: 'x'.repeat(31), id: 'ABC', version: '', installationNumber: 'x'.repeat(101), producerNif: undefined } })), 'error')

      expect(issues).toEqual(expect.arrayContaining(['text-too-long@system.name', 'text-too-long@system.id', 'required@system.version', 'text-too-long@system.installationNumber', 'id-choice@system']))
    })

    test('a chain link that is incomplete', () => {
      const issues = codes(validateInvoiceRecord(changed({ chaining: { previous: { issuerNif: IssuerNif, number: '', issueDate: 'nope', hash: '' } } })), 'error')

      expect(issues).toEqual(expect.arrayContaining(['required@chaining.previous.number', 'invalid-date@chaining.previous.issueDate', 'required@chaining.previous.hash']))
    })

    test('a chaining that is neither first nor linked', () => {
      expect(codes(validateInvoiceRecord(changed({ chaining: {} })), 'error')).toContain('required@chaining.previous')
    })

    test('too many listed invoices', () => {
      const ref = { issuerNif: IssuerNif, number: '1', issueDate: '2024-01-01' }

      expect(codes(validateInvoiceRecord(changed({ rectifiedInvoices: Array.from({ length: 1001 }, () => ref) })), 'error')).toContain('too-many@rectifiedInvoices')
    })
  })

  describe('warnings: rules the schema cannot express', () => {
    test('a hash that does not match the content', () => {
      expect(codes(validateInvoiceRecord(changed({ description: 'Changed after hashing', totalAmount: '999.00' })), 'warning')).toContain('hash-mismatch@hash')
    })

    test('a taxed line without a rate or tax, and a not-subject line with them', () => {
      const taxed = validateInvoiceRecord(changed({ breakdown: [{ qualification: 'S1', taxableBase: '10.00' }], totalTax: '0.00', totalAmount: '10.00' }))
      const notSubject = validateInvoiceRecord(changed({ breakdown: [{ qualification: 'N2', taxRate: '21', taxableBase: '10.00' }], totalTax: '0.00', totalAmount: '10.00' }))

      expect(codes(taxed, 'warning')).toContain('tax-expected@breakdown[0]')
      expect(codes(notSubject, 'warning')).toContain('tax-unexpected@breakdown[0]')
    })

    test('a complete invoice with no recipient, unless marked as issued without one', () => {
      expect(codes(validateInvoiceRecord(changed({ recipients: undefined })), 'warning')).toContain('recipient-expected@recipients')
      expect(codes(validateInvoiceRecord(changed({ recipients: undefined, withoutRecipientArt61d: true })), 'warning')).not.toContain('recipient-expected@recipients')
    })

    test('a simplified invoice that names a recipient', () => {
      expect(codes(validateInvoiceRecord(changed({ invoiceType: 'F2' })), 'warning')).toContain('recipient-unexpected@recipients')
    })

    test('a corrective invoice without its details, and details on a non-corrective one', () => {
      expect(codes(validateInvoiceRecord(changed({ invoiceType: 'R1' })), 'warning')).toEqual(expect.arrayContaining(['rectification-expected@rectification', 'rectified-expected@rectifiedInvoices']))
      expect(codes(validateInvoiceRecord(changed({ invoiceType: 'R1', rectification: 'S', rectifiedInvoices: [{ issuerNif: IssuerNif, number: '1', issueDate: '2024-01-01' }] })), 'warning')).toContain('rectified-amounts-expected@rectifiedAmounts')
      expect(codes(validateInvoiceRecord(changed({ rectification: 'I' })), 'warning')).toContain('rectification-unexpected@invoiceType')
    })

    test('an invoice replacing simplified ones that does not list them', () => {
      expect(codes(validateInvoiceRecord(changed({ invoiceType: 'F3' })), 'warning')).toContain('substituted-expected@substitutedInvoices')
    })

    test('inconsistent amendment flags', () => {
      expect(codes(validateInvoiceRecord(changed({ previousRejection: 'X' })), 'warning')).toContain('amendment-expected@amendment')
      expect(codes(validateInvoiceRecord(changed({ amendment: true, previousRejection: 'S' })), 'warning')).toContain('rejection-code@previousRejection')
    })

    test('totals that do not follow from the breakdown', () => {
      const issues = codes(validateInvoiceRecord(changed({ totalTax: '50.00', totalAmount: '500.00' })), 'warning')

      expect(issues).toEqual(expect.arrayContaining(['total-tax-mismatch@totalTax', 'total-amount-mismatch@totalAmount']))
    })

    test('allows a cent of rounding a line in the totals', () => {
      const record = changed({ totalTax: '12.36', totalAmount: '123.46' })

      expect(withoutHashWarning(validateInvoiceRecord(record))).toEqual([])
    })

    test('an invoice number outside printable ASCII, which the QR code cannot hold', () => {
      expect(codes(validateInvoiceRecord(changed({ id: { issuerNif: IssuerNif, number: 'Factura Ñ 1', issueDate: '2024-01-01' } })), 'warning')).toContain('number-not-ascii@id.number')
    })

    test('a foreign VAT number without a country', () => {
      expect(codes(validateInvoiceRecord(changed({ recipients: [{ name: 'A', otherId: { type: '02', id: 'DE123' } }] })), 'warning')).toContain('country-expected@recipients[0].otherId.countryCode')
    })
  })
})

describe('validateCancellationRecord', () => {
  const cancellation = () => createCancellationRecord(cancellationInput())

  test('finds nothing wrong with a sound record', () => {
    expect(validateCancellationRecord(cancellation())).toEqual([])
  })

  test('finds a schema error and a business warning', () => {
    const record = { ...cancellation(), previousRejection: 'X' as never, generatedBy: 'D' as const }

    expect(codes(validateCancellationRecord(record), 'error')).toContain('invalid-code@previousRejection')
    expect(codes(validateCancellationRecord(record), 'warning')).toContain('generator-expected@generator')
  })

  test('finds a changed record', () => {
    expect(codes(validateCancellationRecord({ ...cancellation(), generatedAt: '2025-01-01T00:00:00+01:00' }), 'warning')).toContain('hash-mismatch@hash')
  })
})

describe('validateHeader', () => {
  test('accepts a taxpayer', () => {
    expect(validateHeader(header)).toEqual([])
  })

  test('finds a bad taxpayer, representative, end date or requirement', () => {
    const issues = codes(validateHeader({
      taxpayer: { name: '', nif: '12' },
      representative: { name: 'x', nif: '1' },
      voluntary: { verifactuEndDate: 'soon' },
      requirement: { reference: 'x'.repeat(19) }
    }))

    expect(issues).toEqual(expect.arrayContaining([
      'required@taxpayer.name', 'nif-length@taxpayer.nif', 'nif-length@representative.nif', 'invalid-date@voluntary.verifactuEndDate', 'text-too-long@requirement.reference', 'both-modes@header'
    ]))
  })
})

describe('validateSubmission', () => {
  const first = () => createInvoiceRecord(invoiceInput())
  const second = () => createInvoiceRecord(invoiceInput({ id: { issuerNif: IssuerNif, number: AeatExamples.second.number, issueDate: '2024-01-01' }, generatedAt: AeatExamples.second.generatedAt }), chainLinkOf(first()))

  test('accepts records in chain order issued by the header\'s taxpayer', () => {
    expect(validateSubmission(header, [first(), second()])).toEqual([])
  })

  test('needs at least one record, and at most 1000', () => {
    expect(codes(validateSubmission(header, []), 'error')).toContain('required@records')
    expect(codes(validateSubmission(header, Array.from({ length: 1001 }, first)), 'error')).toContain('too-many@records')
  })

  test('prefixes a record\'s issues with its position', () => {
    const issues = validateSubmission(header, [first(), { ...second(), description: '' }])

    expect(codes(issues, 'error')).toContain('required@records[1].description')
  })

  test('warns of a record issued by someone other than the taxpayer, and of records out of order', () => {
    const other = createInvoiceRecord(invoiceInput({ id: { issuerNif: 'B12345674', number: '1', issueDate: '2024-01-01' } }))
    const issues = codes(validateSubmission(header, [second(), first()]), 'warning')

    expect(codes(validateSubmission(header, [other]), 'warning')).toContain('issuer-differs@records[0].id.issuerNif')
    expect(issues).toContain('out-of-order@records[1].chaining')
  })
})

describe('assertNoErrors', () => {
  test('throws for an error and not for warnings alone', () => {
    expect(() => assertNoErrors([{ severity: 'warning', code: 'w', path: 'p', message: 'm' }])).not.toThrow()
    expect(() => assertNoErrors([{ severity: 'error', code: 'e', path: 'p', message: 'm' }])).toThrow(VerifactuValidationError)
  })

  test('puts the errors in the message', () => {
    try {
      assertNoErrors([{ severity: 'error', code: 'e', path: 'description', message: 'must not be empty' }])
    }
    catch (error) {
      expect((error as Error).message).toContain('description: must not be empty')
    }
  })
})
