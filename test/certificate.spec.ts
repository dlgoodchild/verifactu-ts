import { daysUntilExpiry, expiresWithin, isExpired, readCertificateInfo } from '~/certificate'
import { VerifactuConfigurationError } from '~/errors'
import { makeCertificate, pfxOf } from '@/helper/verifactu.helper'

const now = new Date('2026-10-25T12:00:00Z')
const day = 24 * 60 * 60 * 1000
const authority = makeCertificate('Authority', new Date('2020-01-01T00:00:00Z'), new Date('2040-01-01T00:00:00Z'))
const leaf = makeCertificate('Leaf', new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'), authority)

describe('readCertificateInfo', () => {
  test('reads a PEM certificate', () => {
    const info = readCertificateInfo({ cert: leaf.pem, key: leaf.keyPem })

    expect(info.commonName).toBe('Leaf')
    expect(info.subject).toContain('CN=Leaf')
    expect(info.issuer).toContain('CN=Authority')
    expect(info.serialNumber).toBe('0A1B2C')
    expect(info.notBefore.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(info.notAfter.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  test('reads a PKCS#12 bundle, as a buffer or as base64 text', () => {
    const pfx = pfxOf(leaf, [], 'secret')

    for (const source of [pfx, pfx.toString('base64')]) {
      const info = readCertificateInfo({ pfx: source, passphrase: 'secret' })
      expect(info.commonName).toBe('Leaf')
      expect(info.notAfter.toISOString()).toBe('2027-01-01T00:00:00.000Z')
      expect(info.serialNumber).toBe('0A1B2C')
    }
  })

  test('picks the certificate of the private key, not the authority bundled with it', () => {
    const info = readCertificateInfo({ pfx: pfxOf(leaf, [authority.cert], 'secret'), passphrase: 'secret' })

    expect(info.commonName).toBe('Leaf')
    expect(info.issuer).toContain('CN=Authority')
  })

  test('refuses a wrong password, damaged data, and nothing at all', () => {
    const pfx = pfxOf(leaf, [], 'secret')

    expect(() => readCertificateInfo({ pfx, passphrase: 'wrong' })).toThrow(VerifactuConfigurationError)
    expect(() => readCertificateInfo({ pfx: Buffer.from('garbage') })).toThrow('check the file and its password')
    expect(() => readCertificateInfo({ cert: 'not pem', key: 'x' })).toThrow(VerifactuConfigurationError)
    expect(() => readCertificateInfo({})).toThrow('PKCS#12 bundle (pfx) or a PEM certificate and key')
  })
})

describe('expiry', () => {
  const info = { notAfter: new Date(now.getTime() + 30 * day + 3600_000) }

  test('counts the whole days left, rounding down, and goes negative once expired', () => {
    expect(daysUntilExpiry(info, now)).toBe(30)
    expect(daysUntilExpiry({ notAfter: new Date(now.getTime() - 2 * day) }, now)).toBe(-2)
  })

  test('is expired only after the last valid moment', () => {
    expect(isExpired({ notAfter: new Date(now.getTime() + 1) }, now)).toBe(false)
    expect(isExpired({ notAfter: new Date(now.getTime() - 1) }, now)).toBe(true)
  })

  test('warns when it expires within a number of days, or already has', () => {
    expect(expiresWithin(info, 45, now)).toBe(true)
    expect(expiresWithin(info, 30, now)).toBe(false)
    expect(expiresWithin({ notAfter: new Date(now.getTime() - day) }, 0, now)).toBe(true)
  })
})
