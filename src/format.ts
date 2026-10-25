import type { Amount, IsoDate } from '~/types'

/**
 * Formatting the way AEAT's schema wants values: dates as `dd-mm-yyyy`, amounts with a point and up to two decimals,
 * timestamps in ISO 8601 with the offset. Pure functions with no dependencies.
 */

const IsoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const AeatDatePattern = /^(\d{2})-(\d{2})-(\d{4})$/
const AmountPattern = /^([+-]?)(\d{1,12})(?:\.(\d{1,2}))?$/
const RatePattern = /^(\d{1,3})(?:\.(\d{1,2}))?$/
const TimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** The time zone invoices are issued in; used to write a `Date` with its offset */
export const SpainTimeZone = 'Europe/Madrid'

/** Whether the text is a real calendar date written `YYYY-MM-DD` */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false
  const match = IsoDatePattern.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** `2024-01-31` to `31-01-2024` */
export function toAeatDate(date: IsoDate): string {
  const match = IsoDatePattern.exec(date)
  if (!isIsoDate(date) || !match) {
    throw new RangeError(`"${date}" is not a calendar date written YYYY-MM-DD`)
  }
  return `${match[3]}-${match[2]}-${match[1]}`
}

/** `31-01-2024` to `2024-01-31` */
export function fromAeatDate(date: string): IsoDate {
  const match = AeatDatePattern.exec(date.trim())
  if (!match) {
    throw new RangeError(`"${date}" is not a date written DD-MM-YYYY`)
  }
  return `${match[3]}-${match[2]}-${match[1]}`
}

/** The calendar date of a `Date` in a time zone, `YYYY-MM-DD` */
export function isoDateOf(date: Date, timeZone: string = SpainTimeZone): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/**
 * A moment as `YYYY-MM-DDThh:mm:ss+01:00` (ISO 8601 with the offset), as `FechaHoraHusoGenRegistro` needs. A `Date` is
 * written in `timeZone` (Spain by default); a text must already be in that form and is returned as it is.
 */
export function formatTimestamp(value: Date | string, timeZone: string = SpainTimeZone): string {
  if (typeof value === 'string') {
    if (!TimestampPattern.test(value)) {
      throw new RangeError(`"${value}" is not an ISO 8601 timestamp with an offset, such as 2024-01-01T19:20:30+01:00`)
    }
    return value
  }
  if (Number.isNaN(value.getTime())) {
    throw new RangeError('The date is not valid')
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset'
  }).formatToParts(value)
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value
  // "GMT+02:00", or just "GMT" at zero
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00'
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`
}

/** An amount in whole cents, from a number or decimal text. Throws for anything AEAT's amount pattern would reject. */
export function toCents(amount: Amount): number {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) {
      throw new RangeError(`"${amount}" is not an amount`)
    }
    const cents = Math.round(amount * 100)
    if (Math.abs(cents) > 99_999_999_999_999) {
      throw new RangeError(`"${amount}" is too large: at most 12 digits before the decimal point`)
    }
    return cents
  }

  const match = AmountPattern.exec(String(amount).trim())
  if (!match) {
    throw new RangeError(`"${amount}" is not an amount: use up to 12 digits, then a point and up to 2 decimals`)
  }
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'))
  return match[1] === '-' ? -cents : cents
}

/** Whole cents as an amount written `12.35` (always two decimals) */
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`${cents} is not a whole number of cents`)
  }
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

/** An amount as AEAT wants it: a point and two decimals (`12.3` becomes `12.30`) */
export function formatAmount(amount: Amount): string {
  return fromCents(toCents(amount))
}

/** Whether the value is an amount AEAT's pattern accepts */
export function isAmount(amount: unknown): amount is Amount {
  if (typeof amount !== 'number' && typeof amount !== 'string') return false
  try {
    toCents(amount)
    return true
  }
  catch {
    return false
  }
}

/** A percentage rate as AEAT wants it: up to three digits and two decimals, no trailing zeros (`21`, `5.5`) */
export function formatRate(rate: Amount): string {
  const text = typeof rate === 'number' ? String(Math.round(rate * 100) / 100) : String(rate).trim()
  const match = RatePattern.exec(text)
  if (!match) {
    throw new RangeError(`"${rate}" is not a tax rate: use up to 3 digits, then a point and up to 2 decimals`)
  }
  const decimals = (match[2] ?? '').replace(/0+$/, '')
  return decimals ? `${Number(match[1])}.${decimals}` : String(Number(match[1]))
}

/** Whether the value is a rate AEAT's pattern accepts */
export function isRate(rate: unknown): rate is Amount {
  if (typeof rate !== 'number' && typeof rate !== 'string') return false
  try {
    formatRate(rate)
    return true
  }
  catch {
    return false
  }
}

/** The sum of amounts, exactly (in whole cents), written as an amount */
export function sumAmounts(amounts: Amount[]): string {
  return fromCents(amounts.reduce<number>((sum, amount) => sum + toCents(amount), 0))
}

/** Whether every character is printable ASCII (codes 32 to 126), which an invoice number must be to go in the QR code */
export function isPrintableAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text)
}

/** Text as it goes in the XML: AEAT trims the ends, so the hash must be calculated on the trimmed value too */
export function cleanText(text: string): string {
  return text.trim()
}
