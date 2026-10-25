/**
 * Where AEAT's services are. The addresses come from AEAT's published service definition (the WSDL
 * `SistemaFacturacion.wsdl`) and QR specification.
 */

/** `test` is AEAT's external test environment (prewww); `production` is the real one */
export type VerifactuEnvironment = 'test' | 'production'

/**
 * The kind of certificate the submitter authenticates with. AEAT serves a personal or representative certificate
 * (and an adviser's) on one address, and a company **seal** certificate on another.
 */
export type CertificateKind = 'personal' | 'seal'

/**
 * Which web service: `verifactu` is the voluntary remission of a system that issues verifiable invoices (VERI*FACTU
 * mode, with a query service too); `requirement` is the remission a system that does not issue verifiable invoices
 * makes when AEAT requires it (submit only).
 */
export type ServiceMode = 'verifactu' | 'requirement'

const Hosts: Record<VerifactuEnvironment, Record<CertificateKind, string>> = {
  production: { personal: 'https://www1.agenciatributaria.gob.es', seal: 'https://www10.agenciatributaria.gob.es' },
  test: { personal: 'https://prewww1.aeat.es', seal: 'https://prewww10.aeat.es' }
}

const Paths: Record<ServiceMode, string> = {
  verifactu: '/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
  requirement: '/wlpl/TIKE-CONT/ws/SistemaFacturacion/RequerimientoSOAP'
}

/** The address of the web service for an environment, certificate kind and service */
export function serviceUrl(environment: VerifactuEnvironment, certificateKind: CertificateKind = 'personal', mode: ServiceMode = 'verifactu'): string {
  return `${Hosts[environment][certificateKind]}${Paths[mode]}`
}

/** The service definition (WSDL) of an environment */
export function wsdlUrl(environment: VerifactuEnvironment): string {
  return environment === 'production'
    ? 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/cont/ws/SistemaFacturacion.wsdl'
    : 'https://prewww2.aeat.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/cont/ws/SistemaFacturacion.wsdl'
}

/** The base of the invoice validation service, which the QR code's URL points to */
export function validationBaseUrl(environment: VerifactuEnvironment, verifiable = true): string {
  const host = environment === 'production' ? 'https://www2.agenciatributaria.gob.es' : 'https://prewww2.aeat.es'
  return `${host}/wlpl/TIKE-CONT/${verifiable ? 'ValidarQR' : 'ValidarQRNoVerifactu'}`
}
