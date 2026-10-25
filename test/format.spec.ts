import {
  cleanText, formatAmount, formatRate, formatTimestamp, fromAeatDate, fromCents, isAmount, isIsoDate, isoDateOf, isPrintableAscii, isRate, sumAmounts, toAeatDate, toCents
} from '~/format'

describe('dates', () => {
  test('are recognised only when they are real calendar dates written YYYY-MM-DD', () => {
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2023-02-29')).toBe(false)
    expect(isIsoDate('2024-13-01')).toBe(false)
    expect(isIsoDate('01-01-2024')).toBe(false)
    expect(isIsoDate('2024-1-1')).toBe(false)
    expect(isIsoDate(undefined)).toBe(false)
  })

  test('are written the way AEAT wants, and read back', () => {
    expect(toAeatDate('2024-01-31')).toBe('31-01-2024')
    expect(fromAeatDate('31-01-2024')).toBe('2024-01-31')
    expect(fromAeatDate(' 05-11-2024 ')).toBe('2024-11-05')
  })

  test('refuse what is not a date', () => {
    expect(() => toAeatDate('2024-02-30')).toThrow('not a calendar date')
    expect(() => fromAeatDate('2024-01-31')).toThrow('DD-MM-YYYY')
  })

  test('are taken from a moment in a time zone, which can differ from UTC', () => {
    const lateInUtc = new Date('2024-06-30T22:30:00Z')

    expect(isoDateOf(lateInUtc, 'UTC')).toBe('2024-06-30')
    expect(isoDateOf(lateInUtc)).toBe('2024-07-01')
  })
})

describe('timestamps', () => {
  test('are written with the offset of the time zone, which changes with summer time', () => {
    expect(formatTimestamp(new Date('2024-01-01T18:20:30Z'))).toBe('2024-01-01T19:20:30+01:00')
    expect(formatTimestamp(new Date('2024-07-01T17:20:30Z'))).toBe('2024-07-01T19:20:30+02:00')
  })

  test('can be written in another zone, including UTC with a +00:00 offset', () => {
    expect(formatTimestamp(new Date('2024-01-01T18:20:30Z'), 'UTC')).toBe('2024-01-01T18:20:30+00:00')
    expect(formatTimestamp(new Date('2024-01-01T18:20:30Z'), 'Atlantic/Canary')).toBe('2024-01-01T18:20:30+00:00')
  })

  test('are never written as hour 24', () => {
    expect(formatTimestamp(new Date('2024-01-01T23:00:00Z'))).toBe('2024-01-02T00:00:00+01:00')
  })

  test('are taken as they are when already written with an offset', () => {
    expect(formatTimestamp('2024-01-01T19:20:30+01:00')).toBe('2024-01-01T19:20:30+01:00')
    expect(formatTimestamp('2024-01-01T18:20:30Z')).toBe('2024-01-01T18:20:30Z')
  })

  test('refuse a text without an offset, and a date that is not valid', () => {
    expect(() => formatTimestamp('2024-01-01T19:20:30')).toThrow('offset')
    expect(() => formatTimestamp('yesterday')).toThrow(RangeError)
    expect(() => formatTimestamp(new Date('nonsense'))).toThrow('not valid')
  })
})

describe('amounts', () => {
  test.each([
    [12.35, '12.35'], [12.3, '12.30'], [12, '12.00'], ['12.3', '12.30'], ['12', '12.00'], ['-5', '-5.00'], ['+5.5', '5.50'], [0, '0.00'], [-0, '0.00'],
    [999999999999.99, '999999999999.99'], ['0.05', '0.05'], [0.1 + 0.2, '0.30']
  ])('%s is written %s', (value, expected) => {
    expect(formatAmount(value as number | string)).toBe(expected)
  })

  test.each(['abc', '', '1.234', '1,5', '1e3', '1234567890123', ' ', '--1'])('refuses "%s"', (value) => {
    expect(() => formatAmount(value)).toThrow(RangeError)
    expect(isAmount(value)).toBe(false)
  })

  test('refuses numbers that are not finite or too large', () => {
    expect(() => formatAmount(Infinity)).toThrow('not an amount')
    expect(() => formatAmount(NaN)).toThrow(RangeError)
    expect(() => formatAmount(1e15)).toThrow('too large')
    expect(isAmount(null)).toBe(false)
    expect(isAmount(undefined)).toBe(false)
  })

  test('are counted in whole cents, exactly', () => {
    expect(toCents('12.35')).toBe(1235)
    expect(toCents('-0.05')).toBe(-5)
    expect(toCents(0.07)).toBe(7)
    expect(fromCents(1235)).toBe('12.35')
    expect(fromCents(-5)).toBe('-0.05')
    expect(fromCents(0)).toBe('0.00')
    expect(() => fromCents(1.5)).toThrow('whole number')
  })

  test('add up exactly, with no floating point drift', () => {
    expect(sumAmounts(['0.1', '0.2'])).toBe('0.30')
    expect(sumAmounts([10, '0.4', '-0.4'])).toBe('10.00')
    expect(sumAmounts([])).toBe('0.00')
  })
})

describe('rates', () => {
  test.each([[21, '21'], ['21.00', '21'], ['5.50', '5.5'], [5.5, '5.5'], ['4', '4'], ['0', '0'], [10.0, '10'], ['100', '100']])('%s is written %s', (value, expected) => {
    expect(formatRate(value as number | string)).toBe(expected)
  })

  test.each(['abc', '', '1000', '21.123', '-1', '1,5'])('refuses "%s"', (value) => {
    expect(() => formatRate(value)).toThrow(RangeError)
    expect(isRate(value)).toBe(false)
  })

  test('are recognised', () => {
    expect(isRate(21)).toBe(true)
    expect(isRate('7.5')).toBe(true)
    expect(isRate(undefined)).toBe(false)
  })
})

describe('text', () => {
  test('is trimmed at the ends only', () => {
    expect(cleanText('  12345678 / G33  ')).toBe('12345678 / G33')
  })

  test('is printable ASCII when every character is code 32 to 126', () => {
    expect(isPrintableAscii('INV-2024/00001 &x')).toBe(true)
    expect(isPrintableAscii('Factura Ñ')).toBe(false)
    expect(isPrintableAscii('tab\t')).toBe(false)
    expect(isPrintableAscii('')).toBe(true)
  })
})
