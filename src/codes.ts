/**
 * The code lists of the VERI*FACTU records, as AEAT's schema (SuministroInformacion.xsd) defines them. Each list is a
 * `const` array of the exact values that go in the XML, with a matching type. Labels are for people (admin screens,
 * error messages): the codes are what matter.
 */

/** `ClaveTipoFacturaType`: the kind of invoice */
export const InvoiceTypes = ['F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5'] as const
export type InvoiceType = typeof InvoiceTypes[number]

export const InvoiceTypeLabels: Record<InvoiceType, string> = {
  F1: 'Invoice (arts. 6, 7.2 and 7.3 of RD 1619/2012)',
  F2: 'Simplified invoice, or invoice without the recipient identified (art. 6.1.d)',
  F3: 'Invoice issued in place of simplified invoices already issued and declared',
  R1: 'Corrective invoice (arts. 80.1, 80.2 and error founded in law)',
  R2: 'Corrective invoice (art. 80.3)',
  R3: 'Corrective invoice (art. 80.4)',
  R4: 'Corrective invoice (other)',
  R5: 'Corrective invoice for simplified invoices'
}

/** Corrective invoices: they need a rectification type and the invoices they correct */
export const CorrectiveInvoiceTypes: readonly InvoiceType[] = ['R1', 'R2', 'R3', 'R4', 'R5']

/** `ClaveTipoRectificativaType`: how a corrective invoice corrects */
export const RectificationTypes = ['S', 'I'] as const
export type RectificationType = typeof RectificationTypes[number]

export const RectificationTypeLabels: Record<RectificationType, string> = {
  S: 'Substitutive: replaces the original invoice',
  I: 'Incremental: the difference to the original invoice'
}

/** `ImpuestoType`: which tax the breakdown line is for */
export const Taxes = ['01', '02', '03', '05'] as const
export type Tax = typeof Taxes[number]

export const TaxLabels: Record<Tax, string> = {
  '01': 'VAT (IVA)',
  '02': 'IPSI (Ceuta and Melilla)',
  '03': 'IGIC (Canary Islands)',
  '05': 'Other'
}

/** `CalificacionOperacionType`: how a taxed or not-subject operation is qualified */
export const OperationQualifications = ['S1', 'S2', 'N1', 'N2'] as const
export type OperationQualification = typeof OperationQualifications[number]

export const OperationQualificationLabels: Record<OperationQualification, string> = {
  S1: 'Subject and not exempt, without reverse charge',
  S2: 'Subject and not exempt, with reverse charge (the recipient is liable)',
  N1: 'Not subject (arts. 7, 14, others)',
  N2: 'Not subject by the localisation rules'
}

/** Qualifications that carry a tax rate and amount; the others (N1, N2) and exemptions are the base only */
export const TaxedQualifications: readonly OperationQualification[] = ['S1', 'S2']

/** `OperacionExentaType`: why an operation is exempt (use instead of a qualification) */
export const Exemptions = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'] as const
export type Exemption = typeof Exemptions[number]

export const ExemptionLabels: Record<Exemption, string> = {
  E1: 'Exempt by article 20',
  E2: 'Exempt by article 21',
  E3: 'Exempt by article 22',
  E4: 'Exempt by articles 23 and 24',
  E5: 'Exempt by article 25',
  E6: 'Exempt on other grounds',
  E7: 'Reserved for IGIC',
  E8: 'Reserved for IGIC'
}

/** `IdOperacionesTrascendenciaTributariaType`: the VAT/IGIC regime key (list L8A) */
export const RegimeKeys = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '14', '15', '17', '18', '19', '20', '21'] as const
export type RegimeKey = typeof RegimeKeys[number]

/**
 * Descriptions are from AEAT's list as it is widely published; they are informational only. The codes themselves are
 * checked against the schema. Codes without a description are in the schema: see list L8A on AEAT's developer portal.
 */
export const RegimeKeyLabels: Partial<Record<RegimeKey, string>> = {
  '01': 'General regime',
  '02': 'Export',
  '03': 'Special regime for used goods, art and antiques',
  '04': 'Special regime for investment gold',
  '05': 'Special regime for travel agencies',
  '06': 'Special regime for groups of entities',
  '07': 'Special cash accounting regime',
  '08': 'Operations subject to IPSI/IGIC',
  '17': 'Operation under the special regimes of chapter XI of title IX (OSS and IOSS)',
  '18': 'Equivalence surcharge',
  '19': 'Special regime for agriculture, livestock and fishing',
  '20': 'Simplified regime'
}

/** `PersonaFisicaJuridicaIDTypeType`: the kind of identifier for a person without a Spanish NIF (`IDOtro`) */
export const OtherIdTypes = ['02', '03', '04', '05', '06', '07'] as const
export type OtherIdType = typeof OtherIdTypes[number]

export const OtherIdTypeLabels: Record<OtherIdType, string> = {
  '02': 'VAT number in another country (NIF-IVA)',
  '03': 'Passport',
  '04': 'Identity document in the country of residence',
  '05': 'Residence certificate',
  '06': 'Other supporting document',
  '07': 'Not registered'
}

/** `GeneradoPorType`: who generated a cancellation record */
export const CancellationGenerators = ['E', 'D', 'T'] as const
export type CancellationGenerator = typeof CancellationGenerators[number]

/** `TercerosODestinatarioType`: whether the invoice was issued by a third party or by the recipient */
export const IssuedByOthers = ['D', 'T'] as const
export type IssuedByOther = typeof IssuedByOthers[number]

/** `TipoHuellaType`: the hash algorithm; `01` is SHA-256, the only one at present */
export const HashTypes = ['01'] as const
export type HashType = typeof HashTypes[number]
export const Sha256HashType: HashType = '01'

/** The only version of the record format at present */
export const RecordFormatVersion = '1.0'

/** `RechazoPrevioType` (alta): whether AEAT rejected an earlier attempt, as the correction procedures define */
export const PreviousRejections = ['N', 'S', 'X'] as const
export type PreviousRejection = typeof PreviousRejections[number]

/** `TipoPeriodoType`: the month a query looks at */
export const Periods = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const
export type Period = typeof Periods[number]

/** `EstadoEnvioType`: the overall result of a submission */
export const SubmissionStatuses = ['Correcto', 'ParcialmenteCorrecto', 'Incorrecto'] as const
export type SubmissionStatus = typeof SubmissionStatuses[number]

/** `EstadoRegistroType`: the result for one record of a submission */
export const RecordStatuses = ['Correcto', 'AceptadoConErrores', 'Incorrecto'] as const
export type RecordStatus = typeof RecordStatuses[number]

/** The state AEAT holds a record in (`EstadoRegistroSFType` and the query's `EstadoRegistroType`) */
export const StoredRecordStatuses = ['Correcta', 'Correcto', 'AceptadaConErrores', 'AceptadoConErrores', 'Anulada', 'Anulado'] as const
export type StoredRecordStatus = typeof StoredRecordStatuses[number]

/** `TipoEventoType`: what an event record in the event log records */
export const EventTypes = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '90'] as const
export type EventType = typeof EventTypes[number]

export const EventTypeLabels: Record<EventType, string> = {
  '01': 'The software started operating as a non-VERI*FACTU system',
  '02': 'The software stopped operating as a non-VERI*FACTU system',
  '03': 'A process to detect anomalies in the billing records was launched',
  '04': 'Anomalies were detected in the integrity, inalterability or traceability of billing records',
  '05': 'A process to detect anomalies in the event records was launched',
  '06': 'Anomalies were detected in the integrity, inalterability or traceability of event records',
  '07': 'A backup was restored (when the software itself manages backups)',
  '08': 'Billing records generated in a period were exported',
  '09': 'Event records generated in a period were exported',
  '10': 'Summary of events',
  '90': 'Other events the software producer chooses to record'
}

/** `TipoAnomaliaType`: the kind of anomaly an anomaly event reports */
export const AnomalyTypes = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '90'] as const
export type AnomalyType = typeof AnomalyTypes[number]

export const AnomalyTypeLabels: Record<AnomalyType, string> = {
  '01': 'Integrity: hash',
  '02': 'Integrity: signature',
  '03': 'Integrity: other',
  '04': 'Chain traceability, record: not the first but its previous record is missing or not logged',
  '05': 'Chain traceability, record: not the last but its next record is missing or not logged',
  '06': 'Chain traceability, record: other',
  '07': 'Chain traceability, hash: the record\'s hash is not the previous-record hash stored in the next record',
  '08': 'Chain traceability, hash: the stored previous-record hash is not the previous record\'s hash',
  '09': 'Chain traceability, hash: other',
  '10': 'Chain traceability: other',
  '11': 'Date traceability: earlier than the previous record\'s date',
  '12': 'Date traceability: later than the next record\'s date',
  '13': 'Date traceability: generated later than the system\'s current date and time',
  '14': 'Date traceability: other',
  '15': 'Traceability: other',
  '90': 'Other'
}
