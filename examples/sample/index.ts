/**
 * A working example of the VERI*FACTU client against AEAT's official TEST system. It only ever uses the test
 * environment, so nothing it sends is real.
 *
 * Setup: fill in `.env` in this folder (see the comments in it), then from the repository root run
 *
 *   npm run sample --                    issue a simplified invoice (F2) and send it
 *   npm run sample --          cancel    cancel the invoice issued last
 *
 * Each run: reads the certificate and shows when it expires, builds a record chained to the previous run's, sends it,
 * reads AEAT's reply, asks AEAT for the month's records, writes the invoice's QR code to `out/qr.png`, and asks AEAT's
 * validation service whether it can see the invoice. The end of the chain is kept in `state.json` (a real application
 * keeps it in its database); delete that file to start a new chain.
 */
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import {
  VerifactuClient, VerifactuError, VerifactuSoapFaultError, buildQrUrl, chainLinkOf, createCancellationRecord, createInvoiceRecord, daysUntilExpiry, generateQrPng,
  isoDateOf, qrTexts, readCertificateInfo, verifyInvoice
} from '~/index'
import type { ChainLink, ClientCertificate, InvoiceId, SoftwareSystem, SubmissionHeader } from '~/index'

dotenv.config({ path: path.join(__dirname, '.env') })

const StateFile = path.join(__dirname, 'state.json')
const OutDir = path.join(__dirname, 'out')

/** What is kept between runs: the end of the chain and the last invoice, to number the next and to cancel */
interface State {
  last?: ChainLink
  lastInvoice?: InvoiceId
  counter: number
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name} in ${path.join(__dirname, '.env')}`)
  return value
}

/** The certificate from the file named by VERIFACTU_CERT_FILE if set, otherwise from the base64 in VERIFACTU_CERT_BASE64 */
function loadCertificate(): ClientCertificate {
  const passphrase = process.env.VERIFACTU_CERT_PASSWORD ?? ''
  const file = process.env.VERIFACTU_CERT_FILE?.trim()
  if (file) {
    const location = path.isAbsolute(file) ? file : path.resolve(__dirname, file)
    if (!fs.existsSync(location)) throw new Error(`VERIFACTU_CERT_FILE does not exist: ${location}`)
    return { pfx: fs.readFileSync(location), passphrase }
  }
  return { pfx: Buffer.from(required('VERIFACTU_CERT_BASE64'), 'base64'), passphrase }
}

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(StateFile, 'utf8')) as State
  }
  catch {
    return { counter: 0 }
  }
}

const saveState = (state: State): void => fs.writeFileSync(StateFile, `${JSON.stringify(state, null, 2)}\n`)

async function main(): Promise<void> {
  const cancel = process.argv[2] === 'cancel'
  const kind = process.env.VERIFACTU_CERT_KIND === 'seal' ? 'seal' : 'personal'
  const taxpayer = { nif: required('VERIFACTU_TAXPAYER_NIF'), name: required('VERIFACTU_TAXPAYER_NAME') }
  const header: SubmissionHeader = { taxpayer }
  const system: SoftwareSystem = {
    producerName: required('VERIFACTU_PRODUCER_NAME'),
    producerNif: required('VERIFACTU_PRODUCER_NIF'),
    name: required('VERIFACTU_SYSTEM_NAME'),
    id: required('VERIFACTU_SYSTEM_ID'),
    version: required('VERIFACTU_SYSTEM_VERSION'),
    installationNumber: required('VERIFACTU_INSTALLATION_NUMBER'),
    onlyVerifactu: true,
    multiTaxpayer: false,
    multipleTaxpayersInUse: false
  }

  // 1. The certificate: read it, and say when it expires
  const certificate = loadCertificate()
  const info = readCertificateInfo(certificate)
  console.log(`Certificate: ${info.commonName ?? info.subject}`)
  console.log(`  valid until ${info.notAfter.toISOString()} (${daysUntilExpiry(info)} days left)`)

  const client = new VerifactuClient({ environment: 'test', certificate, certificateKind: kind })
  console.log(`Sending to ${client.url}\n`)

  // 2. Build the record, chained to the one before
  const state = loadState()
  const now = new Date()
  let record
  let id: InvoiceId
  if (cancel) {
    if (!state.lastInvoice) throw new Error('There is no invoice to cancel yet: run the sample without "cancel" first')
    id = state.lastInvoice
    record = createCancellationRecord({ id, system, generatedAt: now }, state.last ?? null)
    console.log(`Cancelling invoice ${id.number}`)
  }
  else {
    state.counter += 1
    id = { issuerNif: taxpayer.nif, number: `SAMPLE-${String(state.counter).padStart(5, '0')}`, issueDate: isoDateOf(now) }
    record = createInvoiceRecord({
      id,
      issuerName: taxpayer.name,
      invoiceType: 'F2', // simplified invoice: no recipient needed
      description: 'Sample subscription',
      breakdown: [{ regimeKey: '01', qualification: 'S1', taxRate: 21, taxableBase: '100.00', taxAmount: '21.00' }],
      system,
      generatedAt: now
    }, state.last ?? null)
    console.log(`Issuing invoice ${id.number}: total ${record.kind === 'alta' ? record.totalAmount : ''} EUR`)
  }
  console.log(`  hash ${record.hash}\n`)

  // 3. Look for problems before sending (errors would stop the send; warnings are advice)
  for (const issue of client.check(header, [record])) console.log(`  ${issue.severity}: ${issue.path} ${issue.message}`)

  // 4. Send it
  const reply = await client.submit(header, [record])
  console.log(`AEAT replied: ${reply.status}, CSV ${reply.csv ?? '(none)'}, wait ${reply.waitSeconds}s before the next submission`)
  for (const line of reply.records) {
    console.log(`  ${line.operation.type} ${line.id.number}: ${line.status}${line.errorCode ? ` (${line.errorCode}: ${line.errorDescription})` : ''}`)
  }

  // 5. Keep the chain only if AEAT stored the record (a rejected one is not part of AEAT's chain)
  const stored = reply.records[0]?.status !== 'Incorrecto'
  if (!stored) {
    console.log('\nThe record was rejected, so the chain is left as it was. Fix the cause and run again.')
    return
  }
  state.last = chainLinkOf(record)
  if (!cancel) state.lastInvoice = id
  else delete state.lastInvoice
  saveState(state)

  // 6. Ask AEAT what it holds for this month
  const month = id.issueDate.slice(5, 7) as '01'
  const held = await client.queryAll({ taxpayer, year: id.issueDate.slice(0, 4), period: month })
  console.log(`\nAEAT holds ${held.length} record(s) for ${id.issueDate.slice(0, 7)}; the latest: ${held[held.length - 1]?.id.number ?? '-'}`)

  if (cancel) return

  // 7. The QR code for the invoice
  const content = { nif: id.issuerNif, number: id.number, issueDate: id.issueDate, amount: record.kind === 'alta' ? record.totalAmount : '0' }
  const url = buildQrUrl(content, { environment: 'test' })
  fs.mkdirSync(OutDir, { recursive: true })
  fs.writeFileSync(path.join(OutDir, 'qr.png'), await generateQrPng(url))
  const texts = qrTexts()
  console.log(`\nQR code written to ${path.join(OutDir, 'qr.png')}`)
  console.log(`  print "${texts.label}" above it and "${texts.caption}" below it\n  ${url}`)

  // 8. Ask AEAT's validation service about the invoice (what a customer scanning the QR would see)
  const verification = await verifyInvoice(content, { environment: 'test' })
  console.log(`\nValidation service: ${verification.outcome} (${verification.message})`)
}

main().catch((error: unknown) => {
  if (error instanceof VerifactuSoapFaultError) {
    console.error(`\nAEAT refused the message: ${error.faultString}${error.aeatCode ? ` (code ${error.aeatCode})` : ''}${error.retryable ? ' - temporary, try again later' : ''}`)
  }
  else if (error instanceof VerifactuError) {
    console.error(`\n${error.name}: ${error.message}`)
  }
  else {
    console.error(`\n${(error as Error).message}`)
  }
  process.exitCode = 1
}).finally(() => process.exit()) // open keep-alive connections would otherwise hold the process for a few seconds
