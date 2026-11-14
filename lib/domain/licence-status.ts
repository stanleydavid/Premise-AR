/**
 * Licence status as the officer sees it. Pure: used by the server (what was seen at inspection time)
 * and by the field view (label colours). Dates are calendar days in Malaysia time.
 */
export type StatusKey = 'ok' | 'warn' | 'bad';
export type LicenceStatus = { key: StatusKey; code: 'SAH' | 'HAMPIR_TAMAT' | 'TAMAT' | 'DIGANTUNG' | 'DIBATALKAN' | 'TIADA_LESEN'; label: string; days: number | null };

export const EXPIRING_DAYS = 30;

export function todayMyt(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const dayNumber = (isoDate: string) => Math.round(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);

export function licenceStatus(licence: { status: string; valid_until: string } | null, today = todayMyt()): LicenceStatus {
  if (!licence) return { key: 'bad', code: 'TIADA_LESEN', label: 'TIADA LESEN', days: null };
  const days = dayNumber(licence.valid_until) - dayNumber(today);
  if (licence.status === 'revoked') return { key: 'bad', code: 'DIBATALKAN', label: 'DIBATALKAN', days };
  if (licence.status === 'suspended') return { key: 'bad', code: 'DIGANTUNG', label: 'DIGANTUNG', days };
  if (days < 0) return { key: 'bad', code: 'TAMAT', label: 'TAMAT', days };
  if (days <= EXPIRING_DAYS) return { key: 'warn', code: 'HAMPIR_TAMAT', label: 'HAMPIR TAMAT', days };
  return { key: 'ok', code: 'SAH', label: 'SAH', days };
}

/** Outcome is decided on the server from the answers, never taken from the client. */
export function inspectionOutcome(answers: Record<string, 'patuh' | 'tidak_patuh' | 'tb'>, applicableRuleIds: string[]) {
  const values = applicableRuleIds.map((id) => answers[id]);
  if (values.includes('tidak_patuh')) return 'tidak_patuh' as const;
  if (values.every((v) => v === 'patuh' || v === 'tb')) return 'patuh' as const;
  return 'belum_lengkap' as const;
}
