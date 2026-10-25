import QRCode from 'qrcode'
import { validationBaseUrl, type VerifactuEnvironment } from '~/environment'
import { formatAmount, fromAeatDate, isIsoDate, isPrintableAscii, toAeatDate } from '~/format'
import type { Amount, IsoDate } from '~/types'

/**
 * The QR code every invoice carries, per AEAT's document "Detalle de las especificaciones técnicas del código QR de
 * la factura" (v0.5.0) and articles 20 and 21 of Order HAC/1177/2024:
 *
 * - The code holds a URL of AEAT's validation service with four parameters: the issuer's NIF, the invoice number, the
 *   issue date and the total.
 * - ISO/IEC 18004, error-correction level M, between 30 x 30 and 40 x 40 mm.
 * - At least 2 mm of blank space all round (6 mm recommended), at the start of the first page, with "QR tributario:"
 *   above it and, for verifiable invoices, "Factura verificable en la sede electrónica de la AEAT" (or "VERI*FACTU") below.
 */

/** The text that must always go above the code */
export const QrLabel = 'QR tributario:'
/** The phrase that must go below the code on verifiable (VERI*FACTU) invoices; "VERI*FACTU" alone is also allowed */
export const VerifiableCaption = 'Factura verificable en la sede electrónica de la AEAT'
export const VerifiableShortCaption = 'VERI*FACTU'

export const QrMinSizeMm = 30
export const QrMaxSizeMm = 40
export const QrMinQuietZoneMm = 2
export const QrRecommendedQuietZoneMm = 6

/** What the code says about an invoice */
export interface QrContent {
  /** `nif`: the NIF of whoever is obliged to issue the invoice (9 characters) */
  nif: string
  /** `numserie`: series and number, at most 60 characters, printable ASCII (codes 32 to 126) */
  number: string
  /** `fecha`: the issue date */
  issueDate: IsoDate
  /** `importe`: the invoice total, at most 12 digits before the decimal point */
  amount: Amount
}

export interface QrUrlOptions {
  environment: VerifactuEnvironment
  /** True (default) for a system that issues verifiable invoices (VERI*FACTU mode); false for one that does not */
  verifiable?: boolean
}

function checkContent(content: QrContent): void {
  if (!content.nif || content.nif.length !== 9) throw new RangeError('The NIF must be exactly 9 characters')
  if (!content.number || content.number.length > 60) throw new RangeError('The invoice number must be 1 to 60 characters')
  if (!isPrintableAscii(content.number)) throw new RangeError('The invoice number may only contain printable ASCII characters (codes 32 to 126)')
  if (!isIsoDate(content.issueDate)) throw new RangeError('The issue date must be a calendar date written YYYY-MM-DD')
}

function paramString(content: QrContent): string {
  checkContent(content)
  // Every value is URL-encoded (a "&" in an invoice number becomes %26), in UTF-8, as AEAT requires
  return [
    `nif=${encodeURIComponent(content.nif)}`,
    `numserie=${encodeURIComponent(content.number)}`,
    `fecha=${encodeURIComponent(toAeatDate(content.issueDate))}`,
    `importe=${encodeURIComponent(formatAmount(content.amount))}`
  ].join('&')
}

/** The URL the QR code holds: exactly the four parameters AEAT allows in it */
export function buildQrUrl(content: QrContent, options: QrUrlOptions): string {
  return `${validationBaseUrl(options.environment, options.verifiable !== false)}?${paramString(content)}`
}

export interface ValidationUrlOptions extends QrUrlOptions {
  /** The language AEAT shows the answer in: `gl`, `ca`, `eu`, `es` (default), `va` or `en` */
  language?: 'gl' | 'ca' | 'eu' | 'es' | 'va' | 'en'
  /** Ask for a machine-readable (JSON) answer. **Never put this URL in a QR code**: the code holds `buildQrUrl` only. */
  json?: boolean
}

/** A URL to look an invoice up in AEAT's validation service, with the optional `idioma` and `formato` parameters */
export function buildValidationUrl(content: QrContent, options: ValidationUrlOptions): string {
  const extra = [options.language ? `idioma=${options.language}` : '', options.json ? 'formato=json' : ''].filter(Boolean).join('&')
  return `${buildQrUrl(content, options)}${extra ? `&${extra}` : ''}`
}

/** What a validation URL holds, read back (`null` when it is not one) */
export function parseQrUrl(url: string): (QrContent & { environment: VerifactuEnvironment, verifiable: boolean }) | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    return null
  }

  for (const environment of ['test', 'production'] as const) {
    for (const verifiable of [true, false]) {
      if (`${parsed.origin}${parsed.pathname}` !== validationBaseUrl(environment, verifiable)) continue
      const nif = parsed.searchParams.get('nif')
      const number = parsed.searchParams.get('numserie')
      const date = parsed.searchParams.get('fecha')
      const amount = parsed.searchParams.get('importe')
      if (!nif || !number || !date || !amount) return null
      try {
        return { nif, number, issueDate: fromAeatDate(date), amount, environment, verifiable }
      }
      catch {
        return null
      }
    }
  }
  return null
}

export interface QrImageOptions {
  /** Side of the code itself in millimetres, 30 to 40 (default 34) */
  sizeMm?: number
  /** Resolution the image is made for (default 300) */
  dpi?: number
  /**
   * White border added around the code, in millimetres (default 0). The image then measures `sizeMm + 2 x quietZoneMm`.
   * AEAT requires at least 2 mm (6 mm recommended) of blank space around the code: either add it here or leave it in the layout.
   */
  quietZoneMm?: number
}

interface Geometry {
  modules: number
  scale: number
  margin: number
}

function geometry(text: string, options: QrImageOptions): Geometry {
  const sizeMm = options.sizeMm ?? 34
  const dpi = options.dpi ?? 300
  const quietZoneMm = options.quietZoneMm ?? 0
  if (!(sizeMm >= QrMinSizeMm && sizeMm <= QrMaxSizeMm)) {
    throw new RangeError(`The code must measure ${QrMinSizeMm} to ${QrMaxSizeMm} mm (asked for ${sizeMm})`)
  }
  if (!(dpi > 0) || quietZoneMm < 0) {
    throw new RangeError('The resolution must be positive and the border cannot be negative')
  }

  // Whole pixels per module keep the squares sharp: the size is as close to the one asked for as that allows
  const modules = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules.size
  const scale = Math.max(1, Math.round((sizeMm / 25.4 * dpi) / modules))
  const margin = quietZoneMm === 0 ? 0 : Math.max(1, Math.round((quietZoneMm / 25.4 * dpi) / scale))
  return { modules, scale, margin }
}

/** The code as a PNG image (level M error correction, black on white) */
export async function generateQrPng(text: string, options: QrImageOptions = {}): Promise<Buffer> {
  const { modules, scale, margin } = geometry(text, options)
  return await QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin, width: scale * (modules + 2 * margin), color: { dark: '#000000', light: '#ffffff' } })
}

/** The code as an SVG document, which scales without loss (size it to 30 to 40 mm in the layout) */
export async function generateQrSvg(text: string, options: Pick<QrImageOptions, 'sizeMm' | 'quietZoneMm'> = {}): Promise<string> {
  const sizeMm = options.sizeMm ?? 34
  if (!(sizeMm >= QrMinSizeMm && sizeMm <= QrMaxSizeMm)) {
    throw new RangeError(`The code must measure ${QrMinSizeMm} to ${QrMaxSizeMm} mm (asked for ${sizeMm})`)
  }
  // In SVG a module is one unit, so the border is counted in modules: how many millimetres one module is at this size
  const modules = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules.size
  const margin = options.quietZoneMm ? Math.max(1, Math.ceil(options.quietZoneMm / (sizeMm / modules))) : 0
  return await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin })
}

/** The code as a `data:image/png;base64,…` URL, for an `<img>` */
export async function generateQrDataUrl(text: string, options: QrImageOptions = {}): Promise<string> {
  return `data:image/png;base64,${(await generateQrPng(text, options)).toString('base64')}`
}

/** The text that goes with the code on an invoice */
export function qrTexts(verifiable = true): { label: string, caption: string | null } {
  return { label: QrLabel, caption: verifiable ? VerifiableCaption : null }
}
