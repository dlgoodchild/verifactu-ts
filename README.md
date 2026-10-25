# VERI*FACTU client

A project-agnostic TypeScript client for Spain's VERI*FACTU invoicing system (AEAT, Real Decreto 1007/2023). It has no framework dependencies and runs on Node 18+.

**Contents:** [Background](#background) · [The two ways to comply](#the-two-ways-to-comply-and-what-this-library-covers) · [Setup](#setup) · [Test and production: accounts and certificates](#test-and-production-accounts-and-certificates) · [Quick start](#quick-start) · [Concepts](#concepts-you-need) · [Way 2: signing and the event log](#the-non-verifactu-way-signing-and-the-event-log) · [API reference](#api-reference) · [Recipes](#recipes) · [Errors](#errors) · [Testing](#testing) · [Not included](#not-included) · [References](#references)

## Background

Spanish businesses must issue invoices from software that, for every invoice, produces a **billing record** (`RegistroFacturacion`): an *alta* when an invoice is issued, an *anulación* when one is cancelled. Each record has a SHA-256 **hash** (*huella*) that includes the hash of the record before it, so records form a tamper-evident **chain**. In **VERI*FACTU** (one of the [two ways to comply](#the-two-ways-to-comply-and-what-this-library-covers), and the one this library is for) the records are also sent to the tax agency (AEAT) as they are created, over a SOAP web service secured with a client certificate, and each printed invoice carries a **QR code** the customer can scan to check it on AEAT's site.

This library does everything on the software side of that: build and validate records, hash and chain them, send them, read the replies, query what AEAT holds, make the QR code, and read the certificate expiry. It is **stateless**: it does not store records or the chain. Your application owns the database, the numbering, and what to do with each reply.

Legal dates: mandatory from 1 January 2027 for corporate taxpayers and 1 July 2027 for others (Real Decreto-ley 15/2025). Software producers must also publish a *declaración responsable*; see [Not included](#not-included).

## The two ways to comply, and what this library covers

The word "mode" causes confusion, so read this before the rest. Spanish law (Real Decreto 1007/2023) lets billing software work in **one of two ways**. The names in AEAT's documents are "VERI*FACTU" and "non-VERI*FACTU" (*no VERI*FACTU*).

| | **1. VERI\*FACTU** | **2. Non-VERI\*FACTU** |
|---|---|---|
| Idea | Every record is **sent to AEAT as it is created**, automatically | Records are **kept by the business**; nothing is sent routinely |
| Who holds the records | You *and* AEAT | Only you |
| Record signing | Not needed (AEAT receiving it is the guarantee) | **Each record must be digitally signed** (XAdES) |
| Event log (*registro de eventos*) | Not needed | **Required**: a signed, chained log of what the software did (start/stop, errors, exports...) |
| QR on invoices | Yes. AEAT can confirm the invoice exists, so it is "verifiable" and the caption says so | Yes, but AEAT cannot confirm it, so there is no "verifiable" caption |
| When does AEAT get the records | Immediately | Only if AEAT issues a formal request (*requerimiento*); then you send what it asks for |
| AEAT web service address | `VerifactuSOAP` | `RequerimientoSOAP` |
| Can you read records back from AEAT? | **Yes** (the query service) | No |

A business can switch from the first to the second; the header's `voluntary.verifactuEndDate` announces the day it stops using VERI*FACTU. Software declares which it supports with `SoftwareSystem.onlyVerifactu` (`true` means it can only be used the first way, as a typical VERI*FACTU-only application does).

### What this library does

**Way 1, VERI\*FACTU, is the main use and the one the Quick start, recipes and sample show.** Build records, chain them, send them to `VerifactuSOAP`, read replies, query records back, print the QR. You never need to read about way 2 for this.

**Way 2, non-VERI\*FACTU, is also supported**, in [its own section below](#the-non-verifactu-way-signing-and-the-event-log):

| Way 2 needs | Provided by |
|---|---|
| Every billing record signed (XAdES) | `createSigner`, `signRecord` |
| Every event record signed | `signEventRecord` |
| An event log, chained and signed | `EventLog` (with your callback, or its own flat file) |
| Sending the records AEAT asks for | `new VerifactuClient({ mode: 'requirement' })` and the `requirement` header |
| Checking signatures and the event chain | `verifySignature`, `verifyEventChain` |

The `mode` option does not mean "VERI*FACTU or some other flavour of it": it chooses **which of AEAT's two web service addresses** the client talks to. The query service exists only on the VERI*FACTU address, so `query` / `queryAll` throw a `VerifactuConfigurationError` in `requirement` mode. **If you are building a VERI\*FACTU system, leave `mode` unset and ignore signing and the event log.** The words "VERI*FACTU mode" elsewhere in this document just mean way 1, the normal case.

Way 2 is newer in this library than way 1 and has had less checking; see [its caveats](#caveats-for-way-2).

## Setup

**Requirements:** Node 18+. Install it:

```sh
npm install verifactu
```

Its dependencies (installed automatically): `fast-xml-parser` (reading replies), `qrcode` (QR images), `node-forge` (reading PKCS#12 certificates, for the certificate expiry and for signing).

Import everything from the package root:

```ts
import { VerifactuClient, createInvoiceRecord /* ... */ } from 'verifactu'
```

### 1. Get a certificate

AEAT authenticates the sender with a **qualified electronic certificate**, as a PKCS#12 file (`.p12`/`.pfx`) plus its password, or a PEM certificate and key. [Test and production: accounts and certificates](#test-and-production-accounts-and-certificates) explains how to get one, for a person or a company, and how to export it. There are two kinds, served on different AEAT hosts:

| Certificate | Use | `certificateKind` |
|---|---|---|
| Personal (*persona física*, e.g. FNMT) or company representative certificate | default | `'personal'` |
| Electronic seal (*sello electrónico*) | automated systems acting for a company | `'seal'` |

The taxpayer in the submission header must be the certificate's holder, or have authorised the holder (e.g. as a *colaborador social* or representative; then also set `representative` in the header).

### 2. Configure

The library takes plain options and reads no environment variables itself; wire them from wherever your app keeps configuration. A typical set:

| Setting | Meaning |
|---|---|
| environment | `'test'` (AEAT's pre-production, `prewww*` hosts) or `'production'` |
| certificate | the PKCS#12 bytes (Buffer, or base64 text) and its passphrase |
| certificate kind | `'personal'` or `'seal'` |
| taxpayer | name and NIF of whoever the invoices are issued for |
| software details | see `SoftwareSystem` below: producer, name, id, version, installation number |

Keep the certificate and passphrase in a secret store, never in the repository. Store the certificate as base64 in an environment variable or secret if you cannot mount a file:

```ts
const certificate = { pfx: process.env.VERIFACTU_CERT_BASE64!, passphrase: process.env.VERIFACTU_CERT_PASSWORD }
```

(A string `pfx` is treated as base64.) The **test and production environments are separate**: AEAT's test environment accepts test certificates and test NIFs, and records sent there are not real. Keep a **separate chain per environment** (and per taxpayer).

### 3. Check it works

```ts
const info = readCertificateInfo(certificate)        // throws VerifactuConfigurationError if the file or password is wrong
console.log(info.commonName, info.notAfter, daysUntilExpiry(info))
```

Then send a record to the `test` environment (see Quick start).

## Test and production: accounts and certificates

This section is for someone who has never dealt with AEAT. The short version: **there is no "account" to open with AEAT to use the web service.** What identifies you is a **qualified electronic certificate** (a file on your computer that proves who you are), and the "test" and "production" environments are two separate sets of AEAT servers that accept that same kind of certificate. Everything below explains how to get the certificate, what each environment is for, and what to prepare.

> Everything here comes from AEAT's and FNMT's own pages (links in [Links](#links-for-getting-set-up)) except where marked **(unconfirmed)**. Procedures and prices change, so check the linked pages before you start.

### The two environments

| | **Test** (*pre-producción*) | **Production** |
|---|---|---|
| Purpose | Try the integration. Nothing sent here has any tax effect: it is stored in a test database | The real thing. Records sent here are your legal invoice records |
| Library setting | `environment: 'test'` | `environment: 'production'` |
| Web service hosts | `prewww1.aeat.es` (personal certificate), `prewww10.aeat.es` (seal certificate) | `www1.agenciatributaria.gob.es` (personal), `www10.agenciatributaria.gob.es` (seal) |
| Invoice validation (QR) | `prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR` | `www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR` |
| Sign-up | None. Having a certificate is enough ("Portal de Pruebas externas": access with an electronic certificate) | None beyond being entitled to issue invoices and having a certificate |
| Limits | For occasional testing only, not bulk or automated load tests; AEAT may block abusive use | The legal obligations: unique numbering, chain, deadlines |
| Chain | Keep a **separate chain** from production | Your real chain |

- **No fictitious invoices in production.** AEAT's developer FAQ (December 2025) says a system that issues real invoices cannot produce "fictitious" ones: an invoice sent to production counts as real even if it was a test. If you must test with production, issue it in a clearly separate series (AEAT suggests something like `PRU25-0001`), describe it as a test, and **cancel it immediately afterwards** with a cancellation record. Do the bulk of your testing in the test environment instead.
- **The numbers are validated.** AEAT checks every NIF in a message against its central database (*Base de Datos Centralizada*), in test as well as production. So the taxpayer NIF you use must really exist and must be one your certificate may act for.

### Which certificate do you need?

The certificate must be a **qualified** electronic certificate from a provider on the EU Trusted List, the same kind AEAT accepts for its other services (AEAT's web service document, section 4). You do not need a different certificate for test: the test portal also just asks you to log in with an electronic certificate. **(unconfirmed)** We expect the same certificate file to work in both environments, with only `environment` changing, but could not find AEAT stating this for the VERI*FACTU test service, so confirm it with your first test.

Pick by who the taxpayer is:

| You are... | Certificate | Where to get it |
|---|---|---|
| A self-employed person (*autónomo*) or private individual, issuing invoices in your own name | A **personal certificate** (*certificado de persona física*) issued to you | FNMT (free), or your electronic ID card (DNIe), or another qualified provider |
| A company (SL, SA...) | A **representative certificate** (*certificado de representante de persona jurídica*, or *de administrador único o solidario*) for the person who runs it, or an **electronic seal certificate** (*sello electrónico*) for the company itself | FNMT (representative certificates are usually paid and need documents from the Mercantile Registry) or another qualified provider |
| A software company sending records for its customers | Your own certificate plus a **social collaboration agreement** with AEAT, *or* each customer authorising you; see below | AEAT |

`certificateKind` in the library: `'personal'` for personal and representative certificates, `'seal'` for electronic seal certificates (these use the different `www10` / `prewww10` hosts).

**Important for a server:** the web service is called by a program, so you need the certificate **as a file** you can export, with its private key. These generally **cannot** be exported, so are not suitable: certificates held only on a mobile phone app, on a smart card such as the electronic ID card (DNIe), or in a cloud signing service. Request the certificate through the **software** route (the key is created in your browser/computer and can be backed up).

### Getting a personal certificate (FNMT, free)

For an individual with a Spanish DNI or NIE. The FNMT (the national mint, Spain's main certificate authority) steps, as described on its site:

1. **Prepare** your computer with the software FNMT lists ("configuración previa") and use the **same computer and browser** for steps 2 and 4.
2. **Request it online** with your NIF/NIE, first surname and email. You receive a **request code** by email.
3. **Prove your identity** in person at a registration office (many are Agencia Tributaria, Social Security or town-council offices; some need an appointment) with your ID and the request code. FNMT also offers identity checking by **video**, which saves the visit.
4. **Download and install** it, about an hour after step 3, and **make a backup copy** straight away.

Then export it to a file (below). A certificate normally lasts **4 years**; renew it before it expires. The library can warn you ahead of time (`readCertificateInfo`, `expiresWithin`).

### Getting a company certificate

- **Representative certificates (FNMT):** *Persona jurídica* (a company), *Administrador único o solidario* (sole or joint administrator), or *Entidad sin personalidad jurídica*. The person requesting it must be the legal representative, and normally has to present documents from the Mercantile Registry. Follow the FNMT pages linked below.
- **Electronic seal:** a certificate issued to the company itself for automated systems (FNMT's "Componentes" page, linked below, is where it may offer them **(unconfirmed)**; other qualified providers sell them too). Use `certificateKind: 'seal'`. **(unconfirmed)** Some AEAT services only accept certain seal certificates; check that your provider's seal is accepted for the VERI*FACTU web service.
- Ask your *gestor* (tax adviser) if you are unsure: they handle this daily and can often request a representative certificate for you.

### Sending on behalf of others (software companies, gestores)

The web service may be used by the taxpayer, a person they have authorised, or a *colaborador social*, in every case with a qualified certificate (AEAT's web service document, section 4.1). Two routes, from AEAT's developer FAQ:

- **Authorisation by the taxpayer:** the taxpayer grants you representation using AEAT's standard model (*Anexo II* of the Resolution of 18 December 2024, BOE-A-2024-27600). Then your certificate can send their records, and you set `representative` in the submission header where the schema asks for it.
- **Social collaboration agreement:** a software company can sign an agreement with AEAT (*convenio de colaboración social*) to send records for customers. AEAT's FAQ says to apply to the Tax Agency office for your registered address, or by email to `comunicacion.sepri@correo.aeat.es`, with a formal request, company name and NIF, the corporate-purpose article of your statutes, the signatory's details and proof of their authority, and contact details.
- Every record in one submission must belong to **one** taxpayer: send separate submissions per taxpayer.

### Exporting the certificate to a file (`.p12`)

This turns the certificate installed on your computer into one file the program can read. Use a strong password and keep the file out of version control.

- **Windows:** run `certmgr.msc` → *Personal* → *Certificates* → right-click your certificate → *All Tasks* → *Export...* → *Yes, export the private key* → *Personal Information Exchange (.PFX)* → set a password.
- **macOS:** *Keychain Access* → *My Certificates* → select it → *File* → *Export Items...* → format *Personal Information Exchange (.p12)*.
- **Firefox:** *Settings* → *Privacy & Security* → *View Certificates* → *Your Certificates* → select it → *Backup...*.
- FNMT's own help: *Exportación / Importación y Eliminación de un Certificado* (link below).

If the export option is greyed out, the key is not exportable (see "Important for a server" above): request a new certificate through the software route.

### Checking it works

1. Look inside the file (this also proves the password is right):
   ```ts
   const info = readCertificateInfo({ pfx: fs.readFileSync('certificate.p12'), passphrase })
   console.log(info.commonName, info.notBefore, info.notAfter, daysUntilExpiry(info))
   ```
2. Check the subject contains your NIF (Spanish personal certificates show it as `IDCES-<NIF>` in the serial number).
3. Run the [sample](sample/index.ts) against the test environment with your NIF as the taxpayer. A fault such as `Codigo[4104].El NIF del titular en la cabecera no está identificado` (AEAT's own documented example) means the NIF is not one AEAT recognises or one your certificate may act for.
4. Only then switch `environment` to `'production'`, with a real invoice.

### Before you go live

- You must be registered with the tax authority as someone who issues invoices (the *censo*, normally through the *alta censal* when you start the activity).
- Your invoicing software needs its **declaración responsable** (a statement by the producer that it meets the rules) and must show the QR code and the "VERI*FACTU" wording. If you are the producer and the only user, you still make the declaration. AEAT publishes examples (link below).
- Mandatory dates: 1 January 2027 for companies, 1 July 2027 for others (Real Decreto-ley 15/2025).
- Plan for **certificate renewal** (set a reminder 60 and 30 days ahead) and keep a backup of the file and password in a secret store.
- If AEAT changes its own server certificates (it renews its electronic office certificate periodically, most recently announced for 16 November 2026), your system must trust the new authorities. Update your trust store if connections start failing with TLS errors.

### Links for getting set up

AEAT
- Test environment portal ("Portal de Pruebas externas"; access with a certificate): https://preportal.aeat.es
- VERI*FACTU technical information (documents, test-environment portal link, WSDL, schemas): https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica.html
- Developer FAQ (December 2025; test invoices, social collaboration, architectures): https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf
- VERI*FACTU home page (information, free AEAT invoicing app, appointment phone service): https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu.html
- Social collaboration (gestiones de colaboración social): https://sede.agenciatributaria.gob.es/Sede/colaborar-agencia-tributaria/colaboracion-social-presentacion-declaraciones/gestiones-colaboracion-social.html
- Authorisation models for social collaborators: https://sede.agenciatributaria.gob.es/Sede/colaborar-agencia-tributaria/colaboracion-social-presentacion-declaraciones/modelos-autorizacion-tramites-colaboradores-sociales.html
- Resolution of 18 December 2024 (representation documents, Anexo II): https://www.boe.es/buscar/act.php?id=BOE-A-2024-27600
- Examples of declaraciones responsables: https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica/ejemplo-declaracion-responsable.html
- Query your submitted records on AEAT's site (production): https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/SvTikeEmitidasQuery

Certificates (FNMT)
- All certificate types: https://www.sede.fnmt.gob.es/certificados
- Personal certificate (*persona física*): https://www.sede.fnmt.gob.es/certificados/persona-fisica
- ...with in-person identity check (the software route you want): https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-software
- ...with video identification: https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-video-identificacion
- Office locator for the identity check: http://mapaoficinascert.appspot.com
- Company representative certificates: https://www.sede.fnmt.gob.es/certificados/certificado-de-representante
- Sole or joint administrator: https://www.sede.fnmt.gob.es/certificados/certificado-de-representante/administrador-unico-solidario
- Legal entity: https://www.sede.fnmt.gob.es/certificados/certificado-de-representante/persona-juridica
- Components / electronic seal: https://www.cert.fnmt.es/componente
- Browsers FNMT supports: https://www.sede.fnmt.gob.es/preguntas-frecuentes/navegadores
- Export, import and delete a certificate: https://www.sede.fnmt.gob.es/preguntas-frecuentes/exp-imp-y-elim-de-certificados

## Quick start

```ts
import {
  VerifactuClient, createInvoiceRecord, chainLinkOf, buildQrUrl, generateQrPng, qrTexts
} from 'verifactu'
import type { ChainLink, SoftwareSystem } from 'verifactu'

// Describes your software. This block goes into every record.
const system: SoftwareSystem = {
  producerName: 'Acme Software SL', producerNif: 'B12345674',
  name: 'AcmeInvoicing',          // max 30 characters
  id: 'AC',                       // max 2 characters, identifies the product
  version: '1.0.0',
  installationNumber: 'INSTALL-0001', // identifies this installation
  onlyVerifactu: true,            // true: this software sends every record to AEAT (VERI*FACTU). false: it can also run the non-VERI*FACTU way
  multiTaxpayer: false,           // the software can serve several taxpayers
  multipleTaxpayersInUse: false   // this installation currently does
}

const client = new VerifactuClient({ environment: 'test', certificate })
const header = { taxpayer: { name: 'Acme SL', nif: 'B12345674' } }

// The last record of this taxpayer's chain in this environment, or null for the first ever
const previous: ChainLink | null = await loadLastChainLink()

const record = createInvoiceRecord({
  id: { issuerNif: 'B12345674', number: '2027-0001', issueDate: '2027-01-15' },
  issuerName: 'Acme SL',
  invoiceType: 'F1',                                   // full invoice
  description: 'Monthly subscription',
  recipients: [{ name: 'Customer SL', nif: 'A58818501' }],
  breakdown: [{ regimeKey: '01', qualification: 'S1', taxRate: 21, taxableBase: '100.00', taxAmount: '21.00' }],
  system,
  generatedAt: new Date()
}, previous)

// SAVE THE RECORD AND ITS HASH BEFORE SENDING, then send.
await saveRecord(record)
const reply = await client.submit(header, [record])
await saveReply(record, reply)   // reply.status, reply.records[0].status, reply.csv

// On the invoice: the QR code and its text
const url = buildQrUrl({ nif: 'B12345674', number: '2027-0001', issueDate: '2027-01-15', amount: record.totalAmount }, { environment: 'test' })
const png = await generateQrPng(url)          // Buffer; 34 mm at 300 dpi
const { label, caption } = qrTexts()          // "QR tributario:" above and "Factura verificable en la sede electrónica de la AEAT" below
```

## Concepts you need

**Record.** One *alta* (`InvoiceRecord`) or *anulación* (`CancellationRecord`) per event. Once created it is **never edited**. A record has an `id` (issuer NIF + invoice number + issue date), the content, a `chaining` block, a `generatedAt` timestamp, and its `hash`.

**Chain.** Each record's hash covers the previous record's hash. Pass `previous` (a `ChainLink`, get it with `chainLinkOf(lastRecord)`) when creating a record; pass `null` for the very first one. **Create and save records one at a time, in order, per taxpayer and environment**: two records made from the same `previous` fork the chain. In a multi-process app, serialise this (a database lock on the chain end).

**Corrections.** To fix an invoice AEAT already holds, make a *new* chained record, not a resend:
- `asAmendment(input)`: a correction (*subsanación*) of an accepted record, keeping the same invoice `id`.
- `afterRejection(input)`: re-sending an *alta* that AEAT rejected (`RechazoPrevio: 'X'`; use when the previous attempt was rejected and never stored).
- `cancellationAfterRejection(input)`: same for a rejected *anulación*.
- To cancel an invoice: `createCancellationRecord`. To change amounts after the fact legally, issue a corrective invoice (`invoiceType: 'R1'`–`'R5'`, with `rectification`, `rectifiedInvoices`, and for substitutive ones `rectifiedAmounts`).

**Validation.** `validate*` functions return `ValidationIssue[]`. `severity: 'error'` is something AEAT's schema rejects; the client refuses to send these. `severity: 'warning'` is a rule that AEAT's business checks are likely to flag (totals not matching, missing recipient on a full invoice, ...); the client still sends. Each issue has a `code`, a `path` such as `breakdown[1].taxRate`, and a message.

**Wait time.** Every reply has `waitSeconds` (`TiempoEsperaEnvio`, default 60). Do not send again before that has passed, unless you have 1000 records waiting (a full batch). `FlowControl` and `submitInBatches` do this for you.

**Duplicates and unknown outcomes.** If a submission times out, you do not know whether AEAT stored it. Send it again: for records AEAT already has it answers `Incorrecto` with code 3000 and a `duplicate` block describing the stored record. Or ask with `client.query`.

**Dates, times and money.** Dates are `YYYY-MM-DD` in this library (written `DD-MM-YYYY` in XML). `generatedAt` is a `Date` or an ISO text with offset; it is written in Spain's time zone (`Europe/Madrid`) with its offset, which changes in summer time. Amounts are numbers or strings, normalised to two decimals via integer cents (no floating-point drift). Tax rates are percent: `21`, `'10'`, `'4'`.

**Invoice numbers** must be 1–60 printable ASCII characters (code 32–126) so they can be put in the QR code.

## The non-VERI*FACTU way: signing and the event log

Skip this section if your software sends every record to AEAT (VERI*FACTU). Read [The two ways to comply](#the-two-ways-to-comply-and-what-this-library-covers) first for what way 2 is.

A way-2 system must, in addition to creating and chaining billing records as in the Quick start:

1. **Sign every billing record** (alta and anulación) with a qualified electronic certificate.
2. **Keep an event log** (*registro de eventos*) of what the software does, as chained and signed event records.
3. **Keep everything** and hand it over when AEAT asks (a *requerimiento*): billing records through the requirement address (`mode: 'requirement'`), event records as exported files.

### Signing records

AEAT's format is *XAdES Enveloped Signature*, class *EPES* (a signature that also names the signature policy), over Canonical XML 1.0, RSA with SHA-256, using the Spanish government's signature policy. The library does all of that:

```ts
import { createSigner, signRecord, verifySignature, invoiceRecordXml } from 'verifactu'

// The same ClientCertificate you give the client: a PKCS#12 bundle, or PEM certificate + key
const signer = createSigner({ pfx, passphrase })

const record = createInvoiceRecord(input, previous)
const signed = await signRecord(record, signer)   // the same record, plus `signed.signature` (XML text)

await saveRecord(signed)                          // keep the signature with the record
await client.submit(header, [signed])             // `mode: 'requirement'`: the signature is included in the message
```

- **The certificate** must be a qualified electronic *signature* certificate that is in force (not expired or revoked) when the record is created, issued by a trust service provider on the EU Trusted List, and held by the taxpayer or someone authorised to act for them (a representative, a *colaborador social*). It can be the same file you use to connect to AEAT. The key must be RSA (at least 1024 bits; use 2048 or more).
- **`createSigner`** checks that the key belongs to the certificate, reads the chain of authorities in a PKCS#12 bundle, and signs in memory. To sign with a smart card or a key service instead, implement `RecordSigner` yourself: `{ certificates: Buffer[] /* DER, signing certificate first */, sign(data: Buffer): Promise<Buffer> /* RSA PKCS#1 v1.5 + SHA-256 */ }`.
- **The signature does not change the record's hash**: sign right after creating it, once. Signing again later changes the signing time but is harmless.
- **`verifySignature(xml)`** checks a signed record or event (`invoiceRecordXml(record, { standalone: true })`, `eventRecordXml(event)`). It confirms nothing was changed since signing and the signature was made by the key of the certificate it carries, returning `{ valid, problems, signingTime, signerSubject, certificate }`. It does **not** decide whether to trust that certificate; check that yourself (`readCertificateInfo` for its dates). It correctly verifies the signed example AEAT publishes.
- A record's `signature` is the `ds:Signature` XML text. `invoiceRecordXml` / `cancellationRecordXml` put it at the end of the record, and the submission includes it.

### The event log

The event log is a chain of **event records**, built like billing records: each has a hash that includes the previous event's hash, and each is signed. Events record what the *software* did, for example "started operating", "stopped", "checked its records and found a broken chain", "exported records".

**Event types** (`EventTypes`, `EventTypeLabels`):

| Type | Event | `data.kind` it needs |
|---|---|---|
| `01` | The software started operating as non-VERI*FACTU | none |
| `02` | The software stopped operating as non-VERI*FACTU | none |
| `03` | A process to detect anomalies in billing records was launched | `billing-anomaly-check` |
| `04` | An anomaly was detected in a billing record | `billing-anomaly` |
| `05` | A process to detect anomalies in event records was launched | `event-anomaly-check` |
| `06` | An anomaly was detected in an event record | `event-anomaly` |
| `07` | A backup was restored (only when the software manages backups itself) | none |
| `08` | Billing records of a period were exported | `billing-export` |
| `09` | Event records of a period were exported | `event-export` |
| `10` | Summary of events | `summary` |
| `90` | Anything else you want to record | none (describe it in `otherData`) |

**`EventLog`** creates, chains, signs and stores events:

```ts
import { EventLog, createSigner } from 'verifactu'

const log = await EventLog.open({
  taxpayer: { name: 'Acme SL', nif: 'B12345674' },
  system,                                  // your SoftwareSystem
  signer: createSigner({ pfx, passphrase })
  // ...where the events go: see below
})

await log.start()                          // event 01, when the software starts up
await log.other('Backup restored by operator')  // event 90
await log.log({ type: '03', data: { kind: 'billing-anomaly-check', hashes: { performed: true, processed: 1200 }, signatures: { performed: true, processed: 1200 }, chain: { performed: true, processed: 1200 }, dates: { performed: false } } })
await log.stop()                           // event 02, when it shuts down
```

`log.log(input)` is the general call (`type`, plus `data`, `otherData`, `issuedBy`/`thirdParty`, and `generatedAt` if not now); `start()`, `stop()` and `other(text)` are shortcuts. Each returns the `EventLogEntry` `{ record, xml }`: the signed record and its signed `RegistroEvento` XML. Calls made at the same time are queued, so events stay in one chain in the order of the calls. If creating or saving an event fails, it is **not** logged and the chain does not move, so retrying is safe.

**Where the events are stored: you choose.**

1. **Your callback (recommended for a real application).** Pass `onEvent` and the log hands you every new event to save in your own database or storage. Because the log cannot see your storage, tell it where the chain ends with `previous` (the link of the last event you saved, `eventLinkOf(record)`, or `null` if there is none). This is required, so a restart can never start a second chain by mistake.

   ```ts
   const last = await db.lastEvent()               // your storage; null if empty
   const log = await EventLog.open({
     taxpayer, system, signer,
     previous: last ? eventLinkOf(last.record) : null,
     onEvent: async (entry) => { await db.insertEvent(entry.record, entry.xml) }  // throw to refuse the event
   })
   ```
   Save `entry.record` (the structured event) and `entry.xml` (the exact signed text, which is what you export to AEAT). The callback must save durably before it returns; if it throws, the event is not logged.

2. **The library's own flat file (no callback).** Without `onEvent`, each event is appended as one line of JSON to a file (`file`, default `verifactu-event-log.jsonl` in the working directory). On start-up the log reads the last line to find the end of the chain, so it survives restarts. Each line is `{ record, xml }`. This is the simplest way to start, and fine for a single application instance. Its limits: one writer only (two processes appending at once could fork the chain), and the file is on one disk, so back it up. If you pass `file` you cannot also pass `onEvent`.

   ```ts
   const log = await EventLog.open({ taxpayer, system, signer, file: '/var/lib/myapp/verifactu-events.jsonl' })
   ```

   Read it back with `readEventLogFile(file)` (every entry, in order).

**Why JSON lines for the flat file?** It is append-only (a new event never rewrites old ones), each event is one self-contained line that is written and flushed to disk before `log` returns, a crash can at worst leave a cut-off last line (which the log detects and refuses to build on, rather than guessing), and it is trivial to read with any tool. The tamper protection comes from the hash chain and signatures, not from the file format. For anything beyond a single instance, use the callback with a database.

**Checking the log.** `verifyEventChain(records, previous?)` checks every hash and every link and returns the problems (`bad-hash`, `bad-link`, `missing-first`, `unexpected-first`); `verifyEventHash(record)` checks one; `verifySignature(entry.xml)` checks a signature. Run them on a schedule, and log the result as events 03/04 (and 05/06 for the event log itself); that is what those events are for.

**Exporting.** `eventRecordXml(record)` is the signed XML of one event (`RegistroEvento`, schema `EventosSIF.xsd`). Exporting events or billing records for a period is your application's job; after you do it, log event 08 or 09 (`data.kind` `billing-export` / `event-export`) describing what was exported.

### Caveats for way 2

- **Not exercised against AEAT.** The signature code reproduces AEAT's published example digests exactly and verifies AEAT's own signed example, and the events follow `EventosSIF.xsd` element by element, but nothing here has been sent to or accepted by AEAT's systems. Test with a real certificate before relying on it.
- **A signed record sent in a SOAP message.** AEAT's examples sign a record on its own, as a standalone document, and so does this library. The signature's digest is over that standalone form. When the record is placed inside the submission message, an XML tool that re-canonicalizes it *in the context of the whole message* would see extra namespaces from the envelope and get a different digest. We could not confirm from AEAT's documents how its service checks this. If AEAT rejects signatures on a submission, this is the first thing to look at (and, if it is, the fix lies in how the record is embedded).
- **Policy and algorithms** follow AEAT's specification v0.1.5 (6 March 2025): the AGE signature policy with its SHA-1 policy digest as the policy itself fixes, RSA with SHA-256 for the signature and the digests, certificate digests with SHA-256, no timestamp (XAdES-T is optional and not added).
- **Only RSA** certificates are supported.
- The checks in `validateEventRecord` are the schema's plus a few sensible business rules; AEAT's own checks are the authority.

## API reference

### Records (`record.ts`)

| Function | Does |
|---|---|
| `createInvoiceRecord(input, previous?, options?)` | Builds an *alta*: normalises values, defaults `totalTax` and `totalAmount` to the sums of the breakdown, sets `chaining`, computes the hash, and validates (throws `VerifactuValidationError` on errors; pass `{ validate: false }` to skip). |
| `createCancellationRecord(input, previous?, options?)` | Builds an *anulación* of the invoice identified by `input.id`. |
| `asAmendment(input)` / `afterRejection(input)` / `cancellationAfterRejection(input)` | Return a copy of the input with the correction flags set; pass the result to the `create*` function with the current chain end. |

`InvoiceRecordInput` fields (see `types.ts` for every one, each commented with its AEAT XML element): `id`, `issuerName`, `invoiceType`, `description`, `breakdown` (1–12 `BreakdownLine`s), `recipients`, `system`, `generatedAt`, plus optional `externalRef`, `rectification`, `rectifiedInvoices`, `substitutedInvoices`, `rectifiedAmounts`, `operationDate`, `thirdParty`, `issuedBy`, `totalTax`, `totalAmount`, and others.

A `BreakdownLine` is either **taxed** (`qualification: 'S1'` subject and not exempt, `'S2'` reverse charge, plus `taxRate` and `taxAmount`) or **not subject** (`'N1'`, `'N2'`) or **exempt** (`exemption: 'E1'`–`'E8'`), never a qualification and an exemption together. `regimeKey` is the VAT regime (`'01'` general, `'02'` export, `'08'` IPSI/IGIC, `'17'` OSS and others; see `codes.ts` for all).

### Hash and chain (`hash.ts`)

| Function | Does |
|---|---|
| `chainLinkOf(record)` | The `ChainLink` to pass as `previous` for the next record. |
| `verifyRecordHash(record)` | True when the stored hash matches the content. |
| `verifyChain(records, previous?)` | Checks hashes and links across records in order; returns `ChainProblem[]` (`bad-hash`, `bad-link`, `missing-first`, `unexpected-first`). Run it on your stored records as a self-audit. |
| `calculateRecordHash`, `computeInvoiceHash`, `computeCancellationHash`, `computeEventHash`, `sha256Hex` | Lower-level pieces. |

### Validation (`validate.ts`)

`validateInvoiceRecord(record)`, `validateCancellationRecord(record)`, `validateHeader(header)`, `validateSubmission(header, records)` (includes ordering, max 1000 records, and per-record checks prefixed `records[i].`), and `assertNoErrors(issues)` which throws `VerifactuValidationError`.

### Client (`client.ts`)

```ts
new VerifactuClient({
  environment,            // 'test' | 'production'  (required)
  certificate,            // { pfx, passphrase } or { cert, key, passphrase }; or give `transport`
  certificateKind,        // 'personal' (default) | 'seal'
  mode,                   // 'verifactu' (default, the normal case) | 'requirement' (AEAT's other address, see "The two ways to comply")
  transport,              // your own VerifactuTransport (tests, custom HTTP stack)
  endpoint,               // override the URL (a proxy or a stub)
  timeoutMs,              // default 60000
  validate                // default true; false skips the local check
})
```

| Method | Does |
|---|---|
| `submit(header, records)` | Validates, sends up to 1000 records in one call, returns a `SubmissionReply`. |
| `submitInBatches(header, records, { flow, sleep, now, onBatch })` | Splits into batches of 1000, waits as AEAT asked between batches, returns the replies. On failure throws `VerifactuBatchError` with the `completed` replies. Use `onBatch` to save each batch's outcome before the next goes. |
| `check(header, records)` | All issues (errors and warnings) without sending. |
| `buildSubmission(header, records)` | The SOAP XML that would be sent. |
| `query(query)` | One page of what AEAT holds (not available with `mode: 'requirement'`), as a `QueryReply` (`records`, `hasMore`, `nextPageKey`). |
| `queryAll(query)` | Follows pagination to the end and returns every `StoredRecord`. |
| `url` | The address in use. |

**Reading a `SubmissionReply`:** `status` is `Correcto` (all accepted), `ParcialmenteCorrecto` or `Incorrecto`. `records[i].status` is `Correcto`, `AceptadoConErrores` (stored, with a warning-level `errorCode`) or `Incorrecto` (not stored: fix and resend with `afterRejection`). `records[i].errorCode`/`errorDescription` explain; `csv` is AEAT's receipt code, keep it. `waitSeconds` is how long to wait next. Error codes are listed in AEAT's web service description (see [References](#references)).

**Submission header (`SubmissionHeader`)**: `taxpayer` (who the invoices are for, required); `representative` (set when an adviser generates the records for the taxpayer); `voluntary` (`{ verifactuEndDate, incident }`: the day the taxpayer stops using VERI*FACTU, and whether the records were created during an incident); `requirement` (`{ reference, finished }`: only with `mode: 'requirement'`, below).

**`mode: 'requirement'` (way 2 only, not needed for VERI*FACTU).** Read [The two ways to comply](#the-two-ways-to-comply-and-what-this-library-covers) first. This points the client at AEAT's *requirement* address, used by a system that does **not** send records routinely to send the ones AEAT has formally asked for (a *requerimiento*). Put `requirement: { reference: '<AEAT reference, max 18 characters>', finished: false }` in the header, and `finished: true` on the last submission. That address has no query. Records sent this way must be signed (`signRecord`): `check` warns about an unsigned one.

**Other client behaviour.** The client validates before sending (errors stop it, warnings do not). Replies with an HTTP error status that carry a SOAP Fault are thrown as `VerifactuSoapFaultError`; any other non-200 reply is a `VerifactuResponseError`. Each request is sent with a 60 s timeout by default (`timeoutMs`).

### Querying records (`client.query`, `client.queryAll`)

AEAT keeps every record you submitted and lets you read them back. There is one query operation, used both to list many records and to read a single one. It exists only on AEAT's standard VERI*FACTU address, which is what the client uses by default; it is not offered by the requirement address (`mode: 'requirement'`), where `query` throws `VerifactuConfigurationError`.

```ts
// One month, every page
const records = await client.queryAll({ taxpayer, year: 2027, period: '03' })

// One record (filter by its number)
const [one] = await client.queryAll({ taxpayer, year: 2027, period: '03', invoiceNumber: '2027-0001' })

// Page by page, if you want to process as you go
let page = await client.query({ taxpayer, year: 2027, period: '03' })
while (true) {
  for (const r of page.records) handle(r)
  if (!page.hasMore) break
  page = await client.query({ taxpayer, year: 2027, period: '03', pageKey: page.nextPageKey })
}
```

`RecordQuery`:

| Field | Meaning |
|---|---|
| `taxpayer` **or** `recipient` | Ask as the issuer, or as the customer the invoices were addressed to (you must give exactly one). `{ name, nif }` |
| `asRepresentative` | Asking as the taxpayer's adviser |
| `year`, `period` | Required. `period` is a month, `'01'`–`'12'`. There is no whole-year query: loop over months |
| `invoiceNumber`, `externalRef` | Exact match on the invoice number / your own reference |
| `issueDate` | A day (`'2027-03-15'`) or a range (`{ from, to }`) |
| `counterparty` | The other party (`Party`) |
| `system` | Only records sent by one software installation |
| `pageKey` | Where the previous page ended (`QueryReply.nextPageKey`) |
| `showIssuerName`, `showSystem` | Also return the issuer name and software details (left out by default) |

`QueryReply`: `records`, `hasMore`, `nextPageKey`, `hasData` (false when nothing matched), `year`, `period`. A page holds at most 10,000 records. Each `StoredRecord` has `id`, `data` (what AEAT holds: type, description, recipients, breakdown, totals, chaining, hash, ... possibly less than you sent), `presentation` (`presenterNif`, `timestamp`, `requestId`) and `state` (`status`: `Correcta`, `AceptadaConErrores` or `Anulada`, which AEAT's schema also allows in the masculine `Correcto` / `AceptadoConErrores` / `Anulado`, so compare with all of `StoredRecordStatuses`; `lastModified`; `errorCode`/`errorDescription`). Use it to reconcile with your own records, for example by comparing `data.hash` with yours.

### Signing (`sign.ts`, `verify-signature.ts`)

| Function | Does |
|---|---|
| `createSigner(certificate)` | A `RecordSigner` from a PKCS#12 bundle or PEM certificate + key. Throws `VerifactuConfigurationError` for a wrong password, a key that is not RSA or does not match the certificate |
| `signRecord(record, signer, { signingTime?, id? })` | The record with `signature` set |
| `signEventRecord(event, signer, options)` | The event record with `signature` set |
| `signXml(xml, signer, { insertBefore })` | Lower level: signs any standalone XML document, returns the `ds:Signature` text |
| `verifySignature(xml)` | `{ valid, problems, signingTime, signerSubject, certificate }` for the first signature in the XML (integrity and key match; not trust) |
| `SignaturePolicy`, `DsNamespace`, `XadesNamespace` | The policy AEAT requires (OID, URL, digest) and the namespaces |

### Event log (`events.ts`, `event-xml.ts`, `event-log.ts`)

| Function | Does |
|---|---|
| `EventLog.open(options)` | A log that creates, chains, signs and stores events: `taxpayer`, `system`, `signer`, then either `onEvent` + `previous`, or `file` (default flat file). `now` replaces the clock |
| `log.log(input)`, `log.start()`, `log.stop()`, `log.other(text)` | Log an event; each returns `{ record, xml }`. `log.lastEvent` is the end of the chain; `log.file` the flat file in use |
| `readEventLogFile(file)` | Every entry of a flat log, in order |
| `createEventRecord(input, previous?, options?)` | Build one event without a log: formats values, chains, hashes, validates |
| `eventLinkOf(record)` | The link to pass as `previous` for the next event |
| `verifyEventChain(records, previous?)`, `verifyEventHash(record)` | Check a chain / one hash |
| `validateEventRecord(record)` | Schema errors and warnings |
| `eventRecordXml(record)` | The `RegistroEvento` XML (with its signature when it has one) |
| `EventTypes`, `EventTypeLabels`, `AnomalyTypes`, `AnomalyTypeLabels`, `EventDataKinds` | Codes and labels |

### Flow control (`flow-control.ts`)

`new FlowControl({ waitSeconds?, lastSentAt? })`: `delayMs(pending)`, `canSend(pending)`, `nextSendAt(pending)`, `recordSubmission(sentAt, waitSeconds)`, and `wait` / `lastSent` to persist. `toBatches(items, size = 1000)`. If your process restarts between submissions, save `wait` and `lastSent` per taxpayer and pass them back in.

### QR code (`qr.ts`)

| Function | Does |
|---|---|
| `buildQrUrl(content, { environment, verifiable? })` | The URL to encode: `nif`, `numserie`, `fecha`, `importe`. `verifiable: false` is for systems not issuing verifiable invoices. |
| `generateQrPng(url, { sizeMm = 34, dpi = 300, quietZoneMm })` | PNG `Buffer`, error-correction level M. Size must be 30–40 mm (AEAT's rule). |
| `generateQrSvg(url, { sizeMm, quietZoneMm })`, `generateQrDataUrl(url, options)` | SVG text / `data:` URL. |
| `qrTexts(verifiable = true)` | `{ label: 'QR tributario:', caption }`: the text AEAT requires above (and for verifiable invoices below) the code. |
| `parseQrUrl(url)` | Reads a scanned URL back into its fields, or `null`. |
| `buildValidationUrl(content, { environment, language?, json? })` | Same URL plus the optional `idioma`/`formato=json` parameters. These must **not** go in the printed QR. |

**Placing the QR on the invoice** (AEAT's rules): 30–40 mm square, with a quiet zone (blank border) of at least 2 mm and ideally 6 mm, on the invoice (at the start of the first page for PDFs), with the label above it and, for VERI*FACTU invoices, the caption below.

### Checking an invoice with AEAT (`validation-service.ts`)

`verifyInvoice(content, { environment, transport?, language?, verifiable? })` asks AEAT's public validation service whether an invoice is registered. No certificate needed. Returns `{ outcome: 'found' | 'not-found' | 'not-verifiable' | 'error', message, errorCodes, invoice? }`.

### Certificate (`certificate.ts`)

| Function | Does |
|---|---|
| `readCertificateInfo({ pfx, passphrase } or { cert })` | `{ subject, commonName, issuer, serialNumber, notBefore, notAfter }`. For a PKCS#12 bundle it picks the certificate belonging to the private key (not a bundled authority). Throws `VerifactuConfigurationError` for a wrong password or damaged file. |
| `daysUntilExpiry(info, now?)` | Whole days left (negative once expired). |
| `isExpired(info, now?)` | True after `notAfter`. |
| `expiresWithin(info, days, now?)` | True if it expires within `days` days (or already has); use for a renewal warning. |

AEAT rejects requests made with an expired certificate, so run a daily check and warn well in advance (e.g. 60, 30 and 7 days), since renewal takes time:

```ts
const info = readCertificateInfo(certificate)
if (expiresWithin(info, 30)) notifyOperator(`Certificate expires ${info.notAfter.toISOString()}`)
```

### Transport (`transport.ts`)

`VerifactuTransport` is `{ send(request): Promise<{ status, body }> }`. `HttpsTransport` is the real implementation (Node `https`, client certificate, timeout, 25 MB reply limit; it opens the certificate on construction so errors appear early). Supply your own transport to use a different HTTP library, a proxy, or a fake in tests.

### Environment (`environment.ts`)

`serviceUrl(environment, certificateKind?, mode?)`, `wsdlUrl(environment)`, `validationBaseUrl(environment, verifiable?)`: the AEAT addresses.

| | personal | seal |
|---|---|---|
| production | `www1.agenciatributaria.gob.es` | `www10.agenciatributaria.gob.es` |
| test | `prewww1.aeat.es` | `prewww10.aeat.es` |

### Formatting (`format.ts`)

| Function | Does |
|---|---|
| `formatAmount(v)` / `isAmount(v)` | Normalises to two decimals (`12` → `'12.00'`), refusing more than two decimals or non-numbers |
| `formatRate(v)` / `isRate(v)` | A percent in AEAT's form (`'21.00'` → `'21'`, `5.5` → `'5.5'`) |
| `toCents(v)` / `fromCents(n)` / `sumAmounts(list)` | Exact arithmetic in whole cents |
| `toAeatDate('2027-03-15')` / `fromAeatDate('15-03-2027')` / `isIsoDate(v)` | Date conversion and check |
| `isoDateOf(date, timeZone = 'Europe/Madrid')` | The calendar date of a moment in Spain (not UTC) |
| `formatTimestamp(date, timeZone = 'Europe/Madrid')` | `2027-03-15T19:20:30+01:00`; text with an offset passes through |
| `isPrintableAscii(text)` / `cleanText(text)` | The QR-safe character check; trim |
| `SpainTimeZone` | `'Europe/Madrid'` |

### Code lists (`codes.ts`, `country-codes.ts`)

Typed constants for every code AEAT's schema allows, each with a matching type: `InvoiceTypes` (`F1`, `F2`, `F3`, `R1`–`R5`), `CorrectiveInvoiceTypes`, `RectificationTypes` (`S` substitution, `I` difference), `Taxes` (`01` VAT, `02` IPSI, `03` IGIC, `05` other), `OperationQualifications` (`S1`, `S2`, `N1`, `N2`) and `TaxedQualifications`, `Exemptions` (`E1`–`E8`), `RegimeKeys`, `OtherIdTypes`, `CancellationGenerators`, `IssuedByOthers`, `PreviousRejections`, `HashTypes`, `Periods`, and the reply statuses `SubmissionStatuses`, `RecordStatuses`, `StoredRecordStatuses`. Display texts (Spanish) are in `InvoiceTypeLabels`, `RectificationTypeLabels`, `TaxLabels`, `OperationQualificationLabels`, `ExemptionLabels`, `RegimeKeyLabels`, `OtherIdTypeLabels`; useful for a dropdown. `CountryCodes` / `isCountryCode(code)` hold AEAT's country list (ISO 3166 plus AEAT's extras).

### Limits and constants

`MaxRecordsPerSubmission` (1000), `MaxBreakdownLines` (12), `MaxListedParties` (1000, recipients and listed invoices) from `validate.ts`; `MaxRecordsPerBatch` (1000) and `DefaultWaitSeconds` (60) from `flow-control.ts`; `QrMinSizeMm` / `QrMaxSizeMm` (30 / 40), `QrMinQuietZoneMm` (2), `QrRecommendedQuietZoneMm` (6), `QrLabel`, `VerifiableCaption` and `VerifiableShortCaption` (`'VERI*FACTU'`, a short caption for tight layouts) from `qr.ts`; `RecordFormatVersion` (`'1.0'`) and `Sha256HashType` from `codes.ts`.

### Low-level XML and hash building (`xml.ts`, `hash.ts`)

You rarely need these; the client uses them. They help when you want to inspect messages, send through your own stack, or test.

| Function | Does |
|---|---|
| `buildSubmissionXml(header, records)` | The full SOAP envelope for a submission (also `client.buildSubmission`) |
| `buildQueryXml(query)` | The SOAP envelope for a query |
| `invoiceRecordXml(record)`, `cancellationRecordXml(record)` | One record's XML fragment, elements in the schema's order |
| `parseSubmissionReply(xml, httpStatus?)`, `parseQueryReply(xml, httpStatus?)` | Read AEAT's reply into typed results; throw `VerifactuSoapFaultError` for a fault or `VerifactuResponseError` for anything unexpected |
| `parseSoapFault(xml, httpStatus?)` | The fault in a message, or `null` |
| `escapeXml(text)`, `Namespaces` | XML escaping (also strips characters XML cannot hold) and the namespace URLs |
| `invoiceHashInput(fields)`, `cancellationHashInput(fields)`, `eventHashInput(fields)` | The exact text that is hashed, as in AEAT's specification; useful for debugging a hash mismatch |

## Recipes

**Issue an invoice (the safe order).** In one database transaction: lock the chain end, build the record from it, store the record (with its hash, status `pending`), commit. Then send, then store the reply (and `csv`). If the send fails with a retryable error, leave the record `pending` and retry later with the same record. Never rebuild a pending record with a new `generatedAt`: the hash would change.

**Send what is queued.**
```ts
const pending = await loadPendingRecords()                         // in chain order
const replies = await client.submitInBatches(header, pending, {
  flow,                                                            // your saved FlowControl
  onBatch: async (reply, records) => { await saveReply(records, reply); await saveFlow(flow) }
})
```

**Handle a rejected record.**
```ts
const rejected = reply.records.filter((r) => r.status === 'Incorrecto' && r.errorCode !== 3000)
// Fix the cause (see errorDescription), then make a new record from the corrected input:
const fixed = createInvoiceRecord(afterRejection(correctedInput), chainLinkOf(lastRecord))
```

**Correct an accepted invoice's data.** `createInvoiceRecord(asAmendment(correctedInput), chainLinkOf(lastRecord))`. For a change in amounts, issue a corrective invoice instead.

**Cancel an invoice.** `createCancellationRecord({ id, system, generatedAt: new Date() }, chainLinkOf(lastRecord))`.

**Audit your data.** `verifyChain(allRecordsInOrder)` returns `[]` when every hash and link is intact.

**Reconcile with AEAT.** `await client.queryAll({ taxpayer, year: 2027, period: '12' })` (one call per month), compare with your records by `id`.

**Test without AEAT.** Give the client a fake `transport` (see `test/helper/verifactu.helper.ts`: `FakeTransport`, `submissionReplyXml`, `faultXml`).

## Errors

All extend `VerifactuError`.

| Error | Meaning | What to do |
|---|---|---|
| `VerifactuValidationError` (`issues`) | A record or header is wrong; nothing was sent | Fix the input |
| `VerifactuConfigurationError` | Missing/unreadable certificate, unusable option | Fix the configuration |
| `VerifactuTransportError` (`retryable`) | No answer: network, TLS, timeout. **Outcome unknown** | Resend the same message after a wait |
| `VerifactuSoapFaultError` (`faultCode`, `aeatCode`, `retryable`, `httpStatus`) | AEAT refused the whole message. `Client` faults (`retryable: false`) mean the message or certificate is wrong; `Server` faults are temporary | Fix and resend, or retry later |
| `VerifactuResponseError` (`retryable`, `httpStatus`) | A reply that is not the expected XML (e.g. a gateway error page) | Retry later |
| `VerifactuBatchError` (`completed`, `cause`) | A batch failed part-way through `submitInBatches` | Save `completed`, resend the remaining batches |

## Testing

Tests are in `test/`, shared fixtures in `test/helper/verifactu.helper.ts`. The hash tests reproduce AEAT's own worked examples, and the signature tests check AEAT's published signed record (`test/fixtures/`). Run them with `npm test`. **The library has not yet been exercised against AEAT's real test environment**; do that with a real certificate before relying on it.

## Not included

- **Creating the export files** AEAT may ask for (billing records and events of a period). The library gives you the signed XML of each record and event; assembling and delivering an export is your application's job (log event 08 / 09 afterwards).
- **Timestamps on signatures** (XAdES-T) and checking that a certificate is trusted, not revoked and not expired on the day it signed. `verifySignature` checks integrity only.
- The **declaración responsable** (a statement the software producer must publish) and certification paperwork.
- Persistence: storing records, the chain end, flow-control state and replies is yours (the event log can use a flat file if you want).

## References

Legal basis
- Real Decreto 1007/2023 (billing software requirements): https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840
- Orden HAC/1177/2024 (technical specifications): https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138
- Real Decreto-ley 15/2025 (new deadlines: 1 Jan / 1 Jul 2027): https://www.boe.es/buscar/doc.php?id=BOE-A-2025-24446

AEAT technical documents
- Web service description ("SWeb"): https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_Descripcion_SWeb.pdf
- Hash (*huella*) specification: https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_especificaciones_huella_hash_registros.pdf
- QR code technical specification: https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/DetalleEspecificacTecnCodigoQRfactura.pdf
- Developer FAQs: https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf

AEAT web pages
- Hash FAQ: https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/huella-hash.html
- VERI*FACTU systems FAQ: https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/sistemas-verifactu.html
- Declaración responsable FAQ: https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/certificacion-sistemas-informaticos-declaracion-responsable.html

Signing and event records
- Technical specification for signing billing and event records (v0.1.5): https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Espec-Tecnicas/EspecTecGenerFirmaElectRfact.pdf
- Signed and unsigned example records (ZIP): https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Espec-Tecnicas/AnexosEjemplosFirmaRegFact.zip
- Page for those documents: https://www.agenciatributaria.es/AEAT.desarrolladores/Desarrolladores/_menu_/Documentacion/Sistemas_Informaticos_de_Facturacion_y_Sistemas_VERI_FACTU/Especificaciones_tecnicas_para_generacion_de_la_firma_electronica_de_los_registros_de_facturacion/Especificaciones_tecnicas_para_generacion_de_la_firma_electronica_de_los_registros_de_facturacion.html
- Signature FAQ: https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/firma.html
- Spanish government electronic signature policy (annex 1): https://sede.administracion.gob.es/politica_de_firma_anexo_1.pdf
- XAdES, ETSI TS 101 903: https://www.etsi.org/deliver/etsi_ts/101900_101999/101903/
- Canonical XML 1.0: https://www.w3.org/TR/2001/REC-xml-c14n-20010315

Schemas and service definitions (production; replace `www2.agenciatributaria.gob.es` by `prewww2.aeat.es` for test)
- WSDL: https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/cont/ws/SistemaFacturacion.wsdl
- SuministroInformacion.xsd (record types): https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd
- SuministroLR.xsd (submission): https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd
- RespuestaSuministro.xsd (submission reply): https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd
- ConsultaLR.xsd (query): https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/ConsultaLR.xsd
- RespuestaConsultaLR.xsd (query reply): https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd
- EventosSIF.xsd (event log): https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/EventosSIF.xsd

Endpoints
- Production, personal certificate: https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP
- Production, seal certificate: https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP
- Test, personal certificate: https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP
- Test, seal certificate: https://prewww10.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP
- Invoice validation (QR) service: https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR (test: https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR)

Libraries
- fast-xml-parser: https://github.com/NaturalIntelligence/fast-xml-parser
- qrcode: https://github.com/soldair/node-qrcode
- node-forge: https://github.com/digitalbazaar/forge
