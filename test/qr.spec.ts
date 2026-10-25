import { buildQrUrl, buildValidationUrl, generateQrDataUrl, generateQrPng, generateQrSvg, parseQrUrl, QrLabel, qrTexts, VerifiableCaption } from '~/qr'
import type { QrContent } from '~/qr'

const content: QrContent = { nif: '89890001K', number: '12345678&G33', issueDate: '2024-01-01', amount: 241.4 }

/** The size of a PNG, from its header */
function pngSize(png: Buffer): { width: number, height: number } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe('the QR URL, per AEAT\'s QR specification', () => {
  test('is AEAT\'s own example for the test environment, with the "&" in the number encoded', () => {
    expect(buildQrUrl(content, { environment: 'test' })).toBe('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.40')
  })

  test('points to the real service in production', () => {
    expect(buildQrUrl({ ...content, number: '12345678-G33', issueDate: '2024-09-01' }, { environment: 'production' }))
      .toBe('https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678-G33&fecha=01-09-2024&importe=241.40')
  })

  test('uses the other service for a system that does not issue verifiable invoices', () => {
    expect(buildQrUrl(content, { environment: 'production', verifiable: false })).toContain('/wlpl/TIKE-CONT/ValidarQRNoVerifactu?')
    expect(buildQrUrl(content, { environment: 'test', verifiable: false })).toContain('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu?')
  })

  test('encodes spaces and other special characters of the number', () => {
    expect(buildQrUrl({ ...content, number: 'A 1/2+3#4%5' }, { environment: 'test' })).toContain('numserie=A%201%2F2%2B3%234%255&')
  })

  test('holds exactly the four parameters, never the optional ones', () => {
    const url = new URL(buildQrUrl(content, { environment: 'test' }))

    expect([...url.searchParams.keys()]).toEqual(['nif', 'numserie', 'fecha', 'importe'])
  })

  test('writes the total with two decimals', () => {
    expect(buildQrUrl({ ...content, amount: '1234' }, { environment: 'test' })).toContain('importe=1234.00')
    expect(buildQrUrl({ ...content, amount: '-5.5' }, { environment: 'test' })).toContain('importe=-5.50')
  })

  test.each([
    [{ nif: '123' }, '9 characters'],
    [{ number: '' }, '1 to 60'],
    [{ number: 'x'.repeat(61) }, '1 to 60'],
    [{ number: 'Factura Ñ' }, 'printable ASCII'],
    [{ issueDate: '2024-02-30' }, 'calendar date']
  ])('refuses a content with %j', (changes, message) => {
    expect(() => buildQrUrl({ ...content, ...changes }, { environment: 'test' })).toThrow(message)
  })

  test('refuses an amount that is not one', () => {
    expect(() => buildQrUrl({ ...content, amount: 'abc' }, { environment: 'test' })).toThrow(RangeError)
  })
})

describe('the validation URL', () => {
  test('adds the optional language and JSON parameters after the four', () => {
    const url = buildValidationUrl(content, { environment: 'test', language: 'en', json: true })

    expect(url).toBe('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.40&idioma=en&formato=json')
  })

  test('is the QR URL when nothing is added', () => {
    expect(buildValidationUrl(content, { environment: 'test' })).toBe(buildQrUrl(content, { environment: 'test' }))
  })
})

describe('parseQrUrl', () => {
  test('reads back what buildQrUrl wrote', () => {
    for (const environment of ['test', 'production'] as const) {
      for (const verifiable of [true, false]) {
        expect(parseQrUrl(buildQrUrl(content, { environment, verifiable }))).toEqual({ nif: '89890001K', number: '12345678&G33', issueDate: '2024-01-01', amount: '241.40', environment, verifiable })
      }
    }
  })

  test('is null for a URL that is not AEAT\'s, lacks a parameter, or is not a URL', () => {
    expect(parseQrUrl('https://example.com/ValidarQR?nif=1&numserie=2&fecha=01-01-2024&importe=1')).toBeNull()
    expect(parseQrUrl('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=1&fecha=01-01-2024')).toBeNull()
    expect(parseQrUrl('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=1&fecha=2024-01-01&importe=1')).toBeNull()
    expect(parseQrUrl('not a url')).toBeNull()
  })
})

describe('the QR image', () => {
  const url = buildQrUrl(content, { environment: 'test' })

  test('is a PNG close to the size asked for (34 mm at 300 dpi is about 402 pixels)', async () => {
    const { width, height } = pngSize(await generateQrPng(url))

    expect(width).toBe(height)
    expect(Math.abs(width - 402)).toBeLessThan(40)
  })

  test('is bigger at a higher resolution or size, and smaller at a smaller one', async () => {
    const base = pngSize(await generateQrPng(url, { sizeMm: 34, dpi: 300 })).width

    expect(pngSize(await generateQrPng(url, { sizeMm: 34, dpi: 600 })).width).toBeGreaterThan(base * 1.7)
    expect(pngSize(await generateQrPng(url, { sizeMm: 40 })).width).toBeGreaterThan(base)
    expect(pngSize(await generateQrPng(url, { sizeMm: 30 })).width).toBeLessThan(base)
  }, 60_000)

  test('grows by the border asked for round it', async () => {
    const plain = pngSize(await generateQrPng(url)).width
    const bordered = pngSize(await generateQrPng(url, { quietZoneMm: 6 })).width

    // 6 mm each side at 300 dpi is about 71 pixels
    expect(bordered - plain).toBeGreaterThan(100)
    expect(bordered - plain).toBeLessThan(180)
  })

  test('refuses a size outside 30 to 40 mm, and bad options', async () => {
    await expect(generateQrPng(url, { sizeMm: 29 })).rejects.toThrow('30 to 40 mm')
    await expect(generateQrPng(url, { sizeMm: 41 })).rejects.toThrow('30 to 40 mm')
    await expect(generateQrPng(url, { dpi: 0 })).rejects.toThrow(RangeError)
    await expect(generateQrPng(url, { quietZoneMm: -1 })).rejects.toThrow(RangeError)
  })

  test('is also available as SVG and as a data URL', async () => {
    expect(await generateQrSvg(url)).toContain('<svg')
    expect(await generateQrSvg(url, { quietZoneMm: 2 })).toContain('<svg')
    await expect(generateQrSvg(url, { sizeMm: 50 })).rejects.toThrow('30 to 40 mm')
    expect(await generateQrDataUrl(url)).toMatch(/^data:image\/png;base64,iVBOR/)
  })
})

describe('the text that goes with the code', () => {
  test('is "QR tributario:" above it and the verifiable phrase below it for VERI*FACTU invoices', () => {
    expect(qrTexts()).toEqual({ label: 'QR tributario:', caption: 'Factura verificable en la sede electrónica de la AEAT' })
    expect(QrLabel).toBe('QR tributario:')
    expect(VerifiableCaption).toContain('verificable')
  })

  test('has no caption for a system that does not issue verifiable invoices', () => {
    expect(qrTexts(false)).toEqual({ label: 'QR tributario:', caption: null })
  })
})
