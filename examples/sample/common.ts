/** Shared by the samples: reads `.env` in this folder and loads the client certificate */
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import type { ClientCertificate } from '~/index'

dotenv.config({ path: path.join(__dirname, '.env') })

export function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name} in ${path.join(__dirname, '.env')}`)
  return value
}

const inSampleFolder = (file: string): string => (path.isAbsolute(file) ? file : path.resolve(__dirname, file))

function readFile(variable: string, file: string): Buffer {
  const location = inSampleFolder(file)
  if (!fs.existsSync(location)) throw new Error(`${variable} does not exist: ${location}`)
  return fs.readFileSync(location)
}

/**
 * The client certificate, from the first of these that is set:
 *   VERIFACTU_CERT_PEM_FILE + VERIFACTU_KEY_PEM_FILE  PEM files (see `npx verifactu p12-to-pem`)
 *   VERIFACTU_CERT_FILE                               a PKCS#12 file
 *   VERIFACTU_CERT_BASE64                             a PKCS#12 file, base64 encoded
 */
export function loadCertificate(): ClientCertificate {
  const passphrase = process.env.VERIFACTU_CERT_PASSWORD ?? ''
  const pemFile = process.env.VERIFACTU_CERT_PEM_FILE?.trim()
  const keyFile = process.env.VERIFACTU_KEY_PEM_FILE?.trim()
  if (pemFile || keyFile) {
    if (!pemFile || !keyFile) throw new Error('Set both VERIFACTU_CERT_PEM_FILE and VERIFACTU_KEY_PEM_FILE')
    // A PEM key is only password-protected if it was made that way; `p12-to-pem` writes it unprotected
    return { cert: readFile('VERIFACTU_CERT_PEM_FILE', pemFile), key: readFile('VERIFACTU_KEY_PEM_FILE', keyFile), ...(passphrase ? { passphrase } : {}) }
  }
  const file = process.env.VERIFACTU_CERT_FILE?.trim()
  if (file) return { pfx: readFile('VERIFACTU_CERT_FILE', file), passphrase }
  return { pfx: Buffer.from(required('VERIFACTU_CERT_BASE64'), 'base64'), passphrase }
}
