#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { pkcs12ToPem } from '~/certificate'

const Usage = `verifactu: command line tools

Usage:
  verifactu p12-to-pem <file.p12> [--password <password>] [--out <directory>] [--force]

p12-to-pem  Converts a PKCS#12 certificate (.p12/.pfx) to PEM files that Node's TLS can always read:
              <name>.cert.pem   the certificate and its chain
              <name>.key.pem    the private key, NOT encrypted (written readable by you only)
            Do this once if sending fails with "Unsupported PKCS12 PFX data", which OpenSSL 3 reports for
            certificates protected with older algorithms. Then use the files as the client certificate:
              { cert: fs.readFileSync('<name>.cert.pem'), key: fs.readFileSync('<name>.key.pem') }

Options:
  --password, -p  The .p12 password. Otherwise the VERIFACTU_CERT_PASSWORD variable, otherwise you are asked.
  --out, -o       The directory for the files (default: next to the .p12).
  --force, -f     Overwrite files that already exist.
  --help, -h      Show this text.
`

interface Options { command?: string, file?: string, password?: string, out?: string, force: boolean, help: boolean }

function parse(args: string[]): Options {
  const options: Options = { force: false, help: false }
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = (): string => {
      const next = args[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--force' || arg === '-f') options.force = true
    else if (arg === '--password' || arg === '-p') options.password = value()
    else if (arg === '--out' || arg === '-o') options.out = value()
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`)
    else positional.push(arg)
  }
  ;[options.command, options.file] = positional
  return options
}

/** Asks for the password without showing what is typed */
function askPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) return reject(new Error('No password given: use --password or set VERIFACTU_CERT_PASSWORD'))
    process.stderr.write(prompt)
    let typed = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stderr.write('\n')
          return resolve(typed)
        }
        if (char === '\u0003') {
          stdin.setRawMode(false)
          process.stderr.write('\n')
          return process.exit(130)
        }
        typed = char === '\u007f' ? typed.slice(0, -1) : typed + char
      }
    }
    stdin.on('data', onData)
  })
}

async function p12ToPem(options: Options): Promise<void> {
  if (!options.file) throw new Error('Give the .p12 file to convert. See --help.')
  const input = path.resolve(options.file)
  if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`)

  const password = options.password ?? process.env.VERIFACTU_CERT_PASSWORD ?? await askPassword('Password for the .p12 (empty if none): ')
  const { cert, key } = pkcs12ToPem(fs.readFileSync(input), password)

  const directory = options.out ? path.resolve(options.out) : path.dirname(input)
  const name = path.basename(input).replace(/\.(p12|pfx)$/i, '')
  const certFile = path.join(directory, `${name}.cert.pem`)
  const keyFile = path.join(directory, `${name}.key.pem`)
  if (!options.force) {
    const existing = [certFile, keyFile].find((file) => fs.existsSync(file))
    if (existing) throw new Error(`${existing} already exists (use --force to overwrite)`)
  }

  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(certFile, cert, { mode: 0o644 })
  fs.writeFileSync(keyFile, key, { mode: 0o600 })
  fs.chmodSync(keyFile, 0o600)
  console.log(`Wrote ${certFile}\nWrote ${keyFile}\n\nThe key file is not encrypted: keep it private and out of version control.`)
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2))
  if (options.help || !options.command) return void console.log(Usage)
  if (options.command === 'p12-to-pem') return p12ToPem(options)
  throw new Error(`Unknown command "${options.command}". See --help.`)
}

main().catch((error: Error) => {
  console.error(`Error: ${error.message}`)
  process.exit(1)
})
