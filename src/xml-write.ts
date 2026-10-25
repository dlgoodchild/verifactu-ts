import type { OtherId, Party, SoftwareSystem } from '~/types'

/**
 * The small pieces every XML builder here shares: escaping, and writing an element or a group of elements. Not part of
 * the public API (it is not exported from the index).
 */

/** Characters XML 1.0 cannot hold at all */
// eslint-disable-next-line no-control-regex
const InvalidXmlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

export function escapeXml(value: string): string {
  return value
    .replace(InvalidXmlCharacters, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export type Scalar = string | number | boolean | null | undefined

export const siNo = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : value ? 'S' : 'N')

/** `<name>value</name>`, or nothing when there is no value */
export function leaf(name: string, value: Scalar): string {
  if (value === undefined || value === null || value === '') return ''
  return `<${name}>${escapeXml(String(value))}</${name}>`
}

/** `<name>…children…</name>`; the children are already XML. Empty (no children) gives nothing. */
export function branch(name: string, ...children: string[]): string {
  const inner = children.join('')
  return inner === '' ? '' : `<${name}>${inner}</${name}>`
}

/** Gives an element name its namespace prefix, e.g. `sum1:` */
export type Qualify = (name: string) => string

export function otherIdXml(q: Qualify, other: OtherId): string {
  return branch(q('IDOtro'), leaf(q('CodigoPais'), other.countryCode), leaf(q('IDType'), other.type), leaf(q('ID'), other.id))
}

export function partyXml(q: Qualify, tag: string, party: Party): string {
  return branch(tag, leaf(q('NombreRazon'), party.name), party.nif !== undefined ? leaf(q('NIF'), party.nif) : party.otherId ? otherIdXml(q, party.otherId) : '')
}

export function systemXml(q: Qualify, system: SoftwareSystem): string {
  return branch(
    q('SistemaInformatico'),
    leaf(q('NombreRazon'), system.producerName),
    system.producerNif !== undefined ? leaf(q('NIF'), system.producerNif) : system.producerOtherId ? otherIdXml(q, system.producerOtherId) : '',
    leaf(q('NombreSistemaInformatico'), system.name),
    leaf(q('IdSistemaInformatico'), system.id),
    leaf(q('Version'), system.version),
    leaf(q('NumeroInstalacion'), system.installationNumber),
    leaf(q('TipoUsoPosibleSoloVerifactu'), siNo(system.onlyVerifactu)),
    leaf(q('TipoUsoPosibleMultiOT'), siNo(system.multiTaxpayer)),
    leaf(q('IndicadorMultiplesOT'), siNo(system.multipleTaxpayersInUse))
  )
}

/** Puts `child` just before the last occurrence of `closingTag` (e.g. a signature at the end of a record) */
export function insertBeforeClosing(xml: string, closingTag: string, child: string): string {
  const at = xml.lastIndexOf(closingTag)
  if (at < 0) throw new RangeError(`The XML has no ${closingTag}`)
  return `${xml.slice(0, at)}${child}${xml.slice(at)}`
}
