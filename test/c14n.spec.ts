import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { canonicalize, findById, findElement, namespaceOf, namespacesInScope, parseXml, textOf } from '~/c14n'
import { VerifactuError } from '~/errors'

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('base64')
const c14n = (xml: string) => canonicalize(parseXml(xml))

describe('against AEAT\'s own signed example (RegistroAlta, XAdES, SHA-256)', () => {
  const Ds = 'http://www.w3.org/2000/09/xmldsig#'

  test('the unsigned record has the digest AEAT\'s signature carries for the whole document', () => {
    expect(sha256(c14n(fixture('aeat-record-unsigned.xml')))).toBe('89qWVKHvtwa2CijR5a+DLFjRkqNjKRiz7fClSu1w0Mk=')
  })

  test('the signed record, with its signature left out, is the same document', () => {
    const signed = parseXml(fixture('aeat-record-signed.xml'))
    const signature = findElement(signed, Ds, 'Signature')!

    expect(sha256(canonicalize(signed, { exclude: signature }))).toBe('89qWVKHvtwa2CijR5a+DLFjRkqNjKRiz7fClSu1w0Mk=')
  })

  test('the signed properties, in the context of the document, have the digest AEAT\'s signature carries', () => {
    const signed = parseXml(fixture('aeat-record-signed.xml'))
    const properties = findById(signed, 'xmldsig-90637596-e368-4bd0-bcf8-d9a7be617d9a-signedprops')!

    expect(sha256(canonicalize(properties))).toBe('7K+GICWKtBQtcs79MHxeWvN+U184qNGGbiXIcA4P6no=')
  })
})

describe('canonical form', () => {
  test('writes empty elements with an end tag, and drops the XML declaration', () => {
    expect(c14n('<?xml version="1.0" encoding="UTF-8"?><a><b/><c></c></a>')).toBe('<a><b></b><c></c></a>')
  })

  test('sorts attributes, and namespace declarations (default first), and uses double quotes', () => {
    expect(c14n('<a z="1" b=\'2\' xmlns:y="urn:y" xmlns="urn:d" xmlns:b="urn:b"/>')).toBe('<a xmlns="urn:d" xmlns:b="urn:b" xmlns:y="urn:y" b="2" z="1"></a>')
  })

  test('sorts attributes by namespace first, then name', () => {
    expect(c14n('<a xmlns:p="urn:p" p:a="1" b="2" a="3"/>')).toBe('<a xmlns:p="urn:p" a="3" b="2" p:a="1"></a>')
  })

  test('escapes text and attribute values the canonical way', () => {
    const xml = '<a t="&lt;&amp;&quot;&#9;&#10;&#13;>">&lt;&gt;&amp;&#13;"\'</a>'

    expect(c14n(xml)).toBe('<a t="&lt;&amp;&quot;&#x9;&#xA;&#xD;>">&lt;&gt;&amp;&#xD;"\'</a>')
  })

  test('sees line endings as line feeds, and literal tabs and line feeds in attributes as spaces', () => {
    expect(c14n('<a t="x\ty\nz">1\r\n2\r3</a>')).toBe('<a t="x y z">1\n2\n3</a>')
  })

  test('keeps whitespace between elements', () => {
    expect(c14n('<a>\n  <b> x </b>\n</a>')).toBe('<a>\n  <b> x </b>\n</a>')
  })

  test('writes a namespace once, on the first element that needs it, not repeated on children', () => {
    expect(c14n('<a xmlns:n="urn:n"><n:b xmlns:n="urn:n"><n:c/></n:b></a>')).toBe('<a xmlns:n="urn:n"><n:b><n:c></n:c></n:b></a>')
  })

  test('writes a redeclared prefix again, and undoes a default namespace with xmlns=""', () => {
    expect(c14n('<a xmlns="urn:1"><b xmlns="urn:2"><c xmlns=""/></b></a>')).toBe('<a xmlns="urn:1"><b xmlns="urn:2"><c xmlns=""></c></b></a>')
  })

  test('a part of a document gets every namespace in scope from the elements around it', () => {
    const root = parseXml('<a xmlns:x="urn:x" xmlns:y="urn:y" xmlns="urn:d"><b><c xmlns:z="urn:z"/></b></a>')
    const c = findElement(root, 'urn:d', 'c')!

    expect(canonicalize(c)).toBe('<c xmlns="urn:d" xmlns:x="urn:x" xmlns:y="urn:y" xmlns:z="urn:z"></c>')
  })

  test('leaves out an excluded element and everything in it', () => {
    const root = parseXml('<a><b><x>1</x></b><c/></a>')

    expect(canonicalize(root, { exclude: root.children[0] as never })).toBe('<a><c></c></a>')
  })
})

describe('reading', () => {
  test('finds an element\'s namespace, the namespaces in scope, text, and elements by name and Id', () => {
    const root = parseXml('<p:a xmlns:p="urn:p" xmlns="urn:d"><b Id="one">x<c>y</c></b></p:a>')
    const b = findById(root, 'one')!

    expect(namespaceOf(root)).toBe('urn:p')
    expect(namespaceOf(b)).toBe('urn:d')
    expect([...namespacesInScope(b).entries()]).toEqual([['p', 'urn:p'], ['', 'urn:d']])
    expect(textOf(b)).toBe('xy')
    expect(findElement(root, 'urn:d', 'c')?.name).toBe('c')
    expect(findElement(root, 'urn:nope', 'c')).toBeNull()
    expect(findById(root, 'none')).toBeNull()
  })

  test('reads character references to any character', () => {
    expect(textOf(parseXml('<a>&#x20AC; &#8364; &#x1F600;</a>'))).toBe('€ € 😀')
  })

  test.each([
    ['comments', '<a><!-- x --></a>'],
    ['CDATA', '<a><![CDATA[x]]></a>'],
    ['DOCTYPE', '<!DOCTYPE a><a/>'],
    ['processing instructions', '<a><?x y?></a>'],
    ['an unclosed element', '<a><b></a>'],
    ['a stray closing tag', '<a></b></a>'],
    ['two roots', '<a/><b/>'],
    ['no root', '  '],
    ['text outside the root', 'x<a/>'],
    ['an unescaped ampersand', '<a>a & b</a>'],
    ['an unknown entity', '<a>&nbsp;</a>'],
    ['a bad attribute', '<a b=c/>']
  ])('refuses %s, rather than guessing', (_name, xml) => {
    expect(() => parseXml(xml)).toThrow(VerifactuError)
  })

  test('allows a > inside an attribute value', () => {
    expect(c14n('<a t="x>y"/>')).toBe('<a t="x>y"></a>')
  })
})
