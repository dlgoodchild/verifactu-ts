import type { ValidationIssue } from '~/types'

/** Base of every error this library throws deliberately */
export class VerifactuError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Something to send or build is invalid; nothing was sent */
export class VerifactuValidationError extends VerifactuError {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Invalid VERI*FACTU data: ${issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.path}: ${issue.message}`).join('; ') || 'see issues'}`)
  }
}

/** The client is set up wrongly (no certificate, an unreadable one, a bad option) */
export class VerifactuConfigurationError extends VerifactuError {}

/** The request could not be completed (network, TLS, timeout): the outcome at AEAT is unknown, so resend */
export class VerifactuTransportError extends VerifactuError {
  readonly retryable = true

  constructor(message: string, public readonly cause?: unknown) {
    super(message)
  }
}

/**
 * AEAT answered with a SOAP Fault. AEAT's guidance: a `Server` fault is a problem on its side, so resend the same
 * message later; a `Client` fault says the message is malformed or wrong, so fix it (see `message`) before sending again.
 */
export class VerifactuSoapFaultError extends VerifactuError {
  constructor(
    public readonly faultCode: string,
    public readonly faultString: string,
    /** The AEAT error code in the text, e.g. 4104 from "Codigo[4104]..." */
    public readonly aeatCode: number | null,
    /** True for a `Server` fault, or one that is not a `Client` fault: resend the same message */
    public readonly retryable: boolean,
    public readonly httpStatus?: number
  ) {
    super(`AEAT fault ${faultCode}: ${faultString}`)
  }
}

/** The reply was not the XML that was expected: resend, as AEAT advises */
export class VerifactuResponseError extends VerifactuError {
  readonly retryable = true

  constructor(message: string, public readonly httpStatus?: number, public readonly body?: string) {
    super(message)
  }
}

/** A submission of several batches stopped part way; `completed` holds the replies of the batches that did go through */
export class VerifactuBatchError extends VerifactuError {
  constructor(message: string, public readonly completed: unknown[], public readonly cause: unknown) {
    super(message)
  }
}
