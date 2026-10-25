import { VerifactuError } from '~/errors'

/**
 * A small XML reader and a canonicalizer for "Canonical XML 1.0" (inclusive, without comments:
 * `http://www.w3.org/TR/2001/REC-xml-c14n-20010315`), which is what AEAT requires for signing. Canonical XML turns an
 * XML document into one exact sequence of characters, so that two parties get the same bytes to hash and sign.
 *
 * Only the XML these records use is supported: elements, attributes, text, character and the five predefined entity
 * references, and an XML declaration. Comments, processing instructions, DOCTYPE and CDATA are refused rather than
 * handled approximately. This is not a general XML library.
 */

export const XmlnsNamespace = 'http://www.w3.org/2000/xmlns/'

export interface XmlAttribute {
  /** The name as written, e.g. `ds:Id` */
  name: string
  prefix: string
  local: string
  value: string
}

export interface XmlText {
  kind: 'text'
  value: string
}

export interface XmlElement {
  kind: 'element'
  /** The name as written, e.g. `sum1:RegistroAlta` */
  name: string
  prefix: string
  local: string
  /** Attributes other than namespace declarations */
  attributes: XmlAttribute[]
  /** Namespaces declared on this element: prefix (`''` for the default namespace) → URI */
  declared: Map<string, string>
  children: XmlNode[]
  parent: XmlElement | null
}

export type XmlNode = XmlElement | XmlText

const NamePattern = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/

function fail(message: string, at: number): never {
  throw new VerifactuError(`The XML cannot be read: ${message} (at character ${at})`)
}

function decodeReferences(text: string, at: number): string {
  return text.replace(/&(?:(#x[0-9A-Fa-f]+|#[0-9]+|lt|gt|amp|quot|apos);)?/g, (_match, reference: string | undefined) => {
    if (reference === undefined) return fail('an unescaped "&"', at)
    if (reference === 'lt') return '<'
    if (reference === 'gt') return '>'
    if (reference === 'amp') return '&'
    if (reference === 'quot') return '"'
    if (reference === 'apos') return '\''
    const code = reference[1] === 'x' ? parseInt(reference.slice(2), 16) : parseInt(reference.slice(1), 10)
    if (!Number.isFinite(code) || code > 0x10FFFF) fail(`invalid character reference &${reference};`, at)
    return String.fromCodePoint(code)
  })
}

/** Reads an XML document into a tree; returns the root element */
export function parseXml(source: string): XmlElement {
  // XML 1.0 says a parser must see every line ending as a single line feed
  const xml = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  let position = 0
  let root: XmlElement | null = null
  let current: XmlElement | null = null

  if (xml.startsWith('<?xml')) {
    const end = xml.indexOf('?>')
    if (end < 0) fail('the XML declaration is not closed', 0)
    position = end + 2
  }

  while (position < xml.length) {
    if (xml[position] !== '<') {
      const next = xml.indexOf('<', position)
      const end = next < 0 ? xml.length : next
      const text = xml.slice(position, end)
      if (current) {
        current.children.push({ kind: 'text', value: decodeReferences(text, position) })
      }
      else if (text.trim() !== '') {
        fail('text outside the root element', position)
      }
      position = end
      continue
    }

    if (xml.startsWith('<!--', position) || xml.startsWith('<?', position) || xml.startsWith('<!', position)) {
      fail('comments, processing instructions, DOCTYPE and CDATA are not supported', position)
    }

    if (xml[position + 1] === '/') {
      const end = xml.indexOf('>', position)
      if (end < 0) fail('a closing tag is not finished', position)
      const name = xml.slice(position + 2, end).trim()
      if (!current || current.name !== name) fail(`unexpected closing tag </${name}>`, position)
      current = current.parent
      position = end + 1
      continue
    }

    const tagEnd = findTagEnd(xml, position)
    const selfClosing = xml[tagEnd - 1] === '/'
    const body = xml.slice(position + 1, selfClosing ? tagEnd - 1 : tagEnd)
    const element = parseStartTag(body, position)
    element.parent = current
    if (current) current.children.push(element)
    else if (root) fail('more than one root element', position)
    else root = element
    if (!selfClosing) current = element
    position = tagEnd + 1
  }

  if (!root) fail('there is no root element', 0)
  if (current) fail(`<${current.name}> is not closed`, xml.length)
  return root
}

/** The index of the `>` that ends the start tag at `from`, skipping any `>` inside attribute values */
function findTagEnd(xml: string, from: number): number {
  let quote = ''
  for (let index = from + 1; index < xml.length; index++) {
    const character = xml[index]
    if (quote) {
      if (character === quote) quote = ''
    }
    else if (character === '"' || character === '\'') quote = character
    else if (character === '>') return index
  }
  return fail('a tag is not finished', from)
}

function parseStartTag(body: string, at: number): XmlElement {
  const match = /^([^\s/>]+)/.exec(body)
  if (!match || !NamePattern.test(match[1])) fail('invalid element name', at)
  const name = match[1]
  const [prefix, local] = splitName(name)
  const element: XmlElement = { kind: 'element', name, prefix, local, attributes: [], declared: new Map(), children: [], parent: null }

  const attributePattern = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/y
  let index = name.length
  while (index < body.length) {
    if (/^\s*$/.test(body.slice(index))) break
    attributePattern.lastIndex = index
    const attribute = attributePattern.exec(body)
    if (!attribute) fail(`invalid attributes on <${name}>`, at)
    index = attributePattern.lastIndex
    const attributeName = attribute[1]
    if (!NamePattern.test(attributeName)) fail(`invalid attribute name ${attributeName}`, at)
    // Attribute values: a literal tab or line feed counts as a space (XML 1.0 attribute-value normalisation)
    const value = decodeReferences((attribute[3] ?? attribute[4]).replace(/[\t\n]/g, ' '), at)
    if (attributeName === 'xmlns') element.declared.set('', value)
    else if (attributeName.startsWith('xmlns:')) element.declared.set(attributeName.slice(6), value)
    else {
      const [attributePrefix, attributeLocal] = splitName(attributeName)
      element.attributes.push({ name: attributeName, prefix: attributePrefix, local: attributeLocal, value })
    }
  }
  return element
}

function splitName(name: string): [string, string] {
  const colon = name.indexOf(':')
  return colon < 0 ? ['', name] : [name.slice(0, colon), name.slice(colon + 1)]
}

/** Every namespace in scope at an element: its own declarations over those of its ancestors */
export function namespacesInScope(element: XmlElement): Map<string, string> {
  const chain: XmlElement[] = []
  for (let node: XmlElement | null = element; node; node = node.parent) chain.unshift(node)
  const scope = new Map<string, string>()
  for (const node of chain) {
    for (const [prefix, uri] of node.declared) scope.set(prefix, uri)
  }
  return scope
}

/** The namespace URI of an element's name, or `''` for none */
export function namespaceOf(element: XmlElement): string {
  return namespacesInScope(element).get(element.prefix) ?? ''
}

/** The first element, in document order, below `from` (or `from` itself) with this namespace and local name */
export function findElement(from: XmlElement, namespace: string, local: string): XmlElement | null {
  if (from.local === local && namespaceOf(from) === namespace) return from
  for (const child of from.children) {
    if (child.kind !== 'element') continue
    const found = findElement(child, namespace, local)
    if (found) return found
  }
  return null
}

/** The first element below `from` (or `from` itself) whose `Id` attribute is `id` */
export function findById(from: XmlElement, id: string): XmlElement | null {
  if (from.attributes.some((attribute) => attribute.local === 'Id' && attribute.value === id)) return from
  for (const child of from.children) {
    if (child.kind !== 'element') continue
    const found = findById(child, id)
    if (found) return found
  }
  return null
}

/** The text inside an element (all its text, descendants included) */
export function textOf(element: XmlElement): string {
  return element.children.map((child) => (child.kind === 'text' ? child.value : textOf(child))).join('')
}

const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;')

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;')

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export interface CanonicalizeOptions {
  /** Leave this element (and everything in it) out: the "enveloped signature" transform removes the signature this way */
  exclude?: XmlElement
}

/**
 * Canonical XML 1.0 of an element and everything in it. When the element is not the document root, the namespaces
 * in scope from its ancestors are written on it, as the specification requires for a part of a document.
 */
export function canonicalize(element: XmlElement, options: CanonicalizeOptions = {}): string {
  return emit(element, new Map(), namespacesInScope(element), options)
}

function emit(element: XmlElement, rendered: Map<string, string>, scope: Map<string, string>, options: CanonicalizeOptions): string {
  const declarations: Array<[string, string]> = []
  for (const [prefix, uri] of scope) {
    if (prefix === 'xml') continue
    const before = rendered.get(prefix)
    if (before === uri) continue
    // `xmlns=""` is only worth writing to undo a default namespace that was written earlier
    if (prefix === '' && uri === '' && !before) continue
    declarations.push([prefix, uri])
  }
  declarations.sort(([a], [b]) => byCodePoint(a, b))

  const nowRendered = new Map(rendered)
  for (const [prefix, uri] of declarations) nowRendered.set(prefix, uri)

  const attributes = [...element.attributes].sort((a, b) => {
    const spaceA = a.prefix ? (scope.get(a.prefix) ?? '') : ''
    const spaceB = b.prefix ? (scope.get(b.prefix) ?? '') : ''
    return byCodePoint(spaceA, spaceB) || byCodePoint(a.local, b.local)
  })

  let output = `<${element.name}`
  for (const [prefix, uri] of declarations) output += ` ${prefix === '' ? 'xmlns' : `xmlns:${prefix}`}="${escapeAttribute(uri)}"`
  for (const attribute of attributes) output += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
  output += '>'

  for (const child of element.children) {
    if (child.kind === 'text') {
      output += escapeText(child.value)
    }
    else if (child !== options.exclude) {
      const childScope = new Map(scope)
      for (const [prefix, uri] of child.declared) childScope.set(prefix, uri)
      output += emit(child, nowRendered, childScope, options)
    }
  }
  return `${output}</${element.name}>`
}
