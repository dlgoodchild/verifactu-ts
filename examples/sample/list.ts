/**
 * Lists the invoices AEAT holds as accepted for the taxpayer in `.env`, read back from AEAT's TEST system with the query
 * service. Set up `.env` as for the main sample (index.ts), then from the repository root run
 *
 *   npm run sample:list --                 the current month
 *   npm run sample:list -- 2026-10         one month
 *   npm run sample:list -- 2026            every month of a year (the query service has no whole-year search)
 *   npm run sample:list -- 2026-10 --all   also show cancelled records
 *
 * "Accepted" means AEAT's status is Correcta, or AceptadaConErrores (stored, but with errors it wants you to fix; shown
 * with a "!"). Cancelled records (Anulada) are left out unless you pass --all.
 */
import { VerifactuClient, VerifactuError, VerifactuSoapFaultError, readCertificateInfo } from '~/index'
import type { StoredRecord } from '~/index'
import { loadCertificate, required } from './common'

const Accepted = ['Correcta', 'Correcto']
const AcceptedWithErrors = ['AceptadaConErrores', 'AceptadoConErrores']

const pad = (value: string | undefined, width: number): string => (value ?? '-').slice(0, width).padEnd(width)

function describe(record: StoredRecord): string {
  const { id, data, state } = record
  const flag = AcceptedWithErrors.includes(state.status) ? '!' : Accepted.includes(state.status) ? ' ' : 'x'
  const total = data.totalAmount ? `${data.totalAmount.padStart(10)} EUR` : ''.padStart(14)
  const note = state.errorCode ? `  (${state.errorCode}: ${state.errorDescription})` : ''
  return `${flag} ${pad(id.number, 24)} ${id.issueDate}  ${pad(data.invoiceType, 3)} ${total}  ${pad(data.description, 30)}${note}`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const showAll = args.includes('--all')
  const when = args.find((arg) => !arg.startsWith('--')) ?? new Date().toISOString().slice(0, 7)
  const match = /^(\d{4})(?:-(\d{2}))?$/.exec(when)
  if (!match) throw new Error(`Give a month as YYYY-MM or a year as YYYY, not "${when}"`)
  const year = match[1]
  const months = match[2] ? [match[2]] : Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))
  if (months.some((month) => +month < 1 || +month > 12)) throw new Error(`"${match[2]}" is not a month`)

  const taxpayer = { nif: required('VERIFACTU_TAXPAYER_NIF'), name: required('VERIFACTU_TAXPAYER_NAME') }
  const certificate = loadCertificate()
  const info = readCertificateInfo(certificate)
  const kind = process.env.VERIFACTU_CERT_KIND === 'seal' ? 'seal' : 'personal'
  const client = new VerifactuClient({ environment: 'test', certificate, certificateKind: kind })
  console.log(`Certificate: ${info.commonName ?? info.subject}`)
  console.log(`Asking ${client.url} for ${taxpayer.nif}\n`)

  let accepted = 0
  let withErrors = 0
  let cancelled = 0
  for (const month of months) {
    const records = await client.queryAll({ taxpayer, year, period: month as '01' })
    const isAccepted = (record: StoredRecord): boolean => [...Accepted, ...AcceptedWithErrors].includes(record.state.status)
    const shown = records.filter((record) => showAll || isAccepted(record))
    for (const record of records) {
      if (Accepted.includes(record.state.status)) accepted++
      else if (AcceptedWithErrors.includes(record.state.status)) withErrors++
      else cancelled++
    }
    if (shown.length === 0) continue
    console.log(`${year}-${month}`)
    for (const record of shown) console.log(`  ${describe(record)}`)
    console.log()
  }

  console.log(`Accepted: ${accepted}, accepted with errors (!): ${withErrors}, cancelled: ${cancelled}${showAll ? ' (x)' : ' (hidden; use --all)'}`)
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
}).finally(() => process.exit())
