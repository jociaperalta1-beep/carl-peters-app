import type { AttendanceMarkDoc, CompanyRules } from './types';

export const DEFAULT_SECTORS = ['Camión', 'Cal Agrícola', 'Tambo', 'Chacra', 'Casa', 'Ganado'];
export const SUPPORT_WHATSAPP = '595971417036';

// Validation constants synchronized verbatim with firebase-blueprint.json
export const SCHEMA_LIMITS = {
  NAME_MAX: 100,
  CI_MAX: 30,
  SECTOR_MAX: 80,
  EMAIL_MAX: 120,
  CONCEPT_MAX: 200,
  INVOICE_MAX: 60,
  SUMMARY_MAX: 600,
  LOGO_MAX: 150000,
  GPS_POINTS_MAX: 300,
  SECTORS_MAX: 50,
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  PIN_PATTERN: /^[0-9]{4}$/,
  DATE_PATTERN: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
  TIME_OR_EMPTY_PATTERN: /^(|[0-9]{2}:[0-9]{2}:[0-9]{2})$/,
};

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function currentYearStr(): string {
  return String(new Date().getFullYear());
}

export function nowTimeStr(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function fmtGs(amount: number): string {
  const rounded = Math.round(Number.isFinite(amount) ? amount : 0);
  return `${rounded.toLocaleString('es-PY')} Gs.`;
}

export function toSec(t?: string): number | null {
  if (!t || !/^\d{2}:\d{2}:\d{2}$/.test(t)) return null;
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

export function fmtHMS(totalSec: number): string {
  const clamped = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

export function fmtHoursDec(totalSec: number): string {
  return `${(Math.max(0, totalSec) / 3600).toFixed(2)} h`;
}

export function shiftDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, (d || 1) + deltaDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function getDayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getDay(); // 0=Sun, 1..5=Mon..Fri, 6=Sat
}

export function localDateTimeToMs(dateStr: string, timeStr?: string): number | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  if (!timeStr || !/^\d{2}:\d{2}:\d{2}$/.test(timeStr)) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, m, s] = timeStr.split(':').map(Number);
  return new Date(y, (mo || 1) - 1, d || 1, h || 0, m || 0, s || 0, 0).getTime();
}

export function dateStrFromMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function computeIntervalSec(
  anchorDate: string,
  startTime: string | undefined,
  endTime: string | undefined,
  startTs: number | undefined,
  endTs: number | undefined,
  includeLiveNow: boolean,
  nowMs: number
): { sec: number; open: boolean; crossedMidnight: boolean } {
  const hasStart = Boolean(startTime && /^\d{2}:\d{2}:\d{2}$/.test(startTime)) || (typeof startTs === 'number' && startTs > 0);
  if (!hasStart) return { sec: 0, open: false, crossedMidnight: false };

  const inMs = typeof startTs === 'number' && startTs > 0 ? startTs : localDateTimeToMs(anchorDate, startTime);
  if (inMs === null) return { sec: 0, open: false, crossedMidnight: false };

  const hasEnd = Boolean(endTime && /^\d{2}:\d{2}:\d{2}$/.test(endTime)) || (typeof endTs === 'number' && endTs > 0);
  if (hasEnd) {
    let outMs = typeof endTs === 'number' && endTs > 0 ? endTs : localDateTimeToMs(anchorDate, endTime);
    if (outMs === null) return { sec: 0, open: false, crossedMidnight: false };
    let crossed = dateStrFromMs(outMs) > dateStrFromMs(inMs);
    if (outMs < inMs) {
      // Shift crossed midnight without explicit next-day timestamp
      outMs += 86400000;
      crossed = true;
    }
    return {
      sec: Math.max(0, Math.floor((outMs - inMs) / 1000)),
      open: false,
      crossedMidnight: crossed,
    };
  }

  // Open shift: calculate live elapsed time if requested and within reasonable overnight window (<= 36h)
  if (includeLiveNow && nowMs >= inMs && nowMs - inMs <= 36 * 3600 * 1000) {
    const crossed = dateStrFromMs(nowMs) > dateStrFromMs(inMs);
    return {
      sec: Math.max(0, Math.floor((nowMs - inMs) / 1000)),
      open: true,
      crossedMidnight: crossed,
    };
  }
  return { sec: 0, open: false, crossedMidnight: false };
}

export function hasOpenPunch(mark?: Partial<AttendanceMarkDoc>): boolean {
  if (!mark) return false;
  if (mark.e1 && !mark.s2) return true;
  if (mark.e3 && !mark.s4) return true;
  const extras = Array.isArray(mark.extraPunches) ? mark.extraPunches : [];
  for (const p of extras) {
    if (p && p.in && !p.out) return true;
  }
  return false;
}

export function computeDayHours(
  mark: Partial<AttendanceMarkDoc> | undefined,
  dateStr: string,
  rules: CompanyRules,
  includeLiveNow = false
): {
  workedSec: number;
  baseWorkedSec: number;
  normSec: number;
  baseExtSec: number;
  extraPunchesSec: number;
  extSec: number;
  isWorkingNow: boolean;
  crossedMidnight: boolean;
} {
  if (!mark) {
    return {
      workedSec: 0,
      baseWorkedSec: 0,
      normSec: 0,
      baseExtSec: 0,
      extraPunchesSec: 0,
      extSec: 0,
      isWorkingNow: false,
      crossedMidnight: false,
    };
  }

  const nowMs = Date.now();
  const allowLive = includeLiveNow && (dateStr === todayStr() || dateStr === shiftDateStr(todayStr(), -1));
  const ts = mark.punchTs || {};

  const seg1 = computeIntervalSec(dateStr, mark.e1, mark.s2, ts.e1, ts.s2, allowLive, nowMs);
  const seg2 = computeIntervalSec(dateStr, mark.e3, mark.s4, ts.e3, ts.s4, allowLive, nowMs);

  const baseWorkedSec = seg1.sec + seg2.sec;
  let isWorkingNow = seg1.open || seg2.open;
  let crossedMidnight = seg1.crossedMidnight || seg2.crossedMidnight;

  let extraPunchesSec = 0;
  const extras = Array.isArray(mark.extraPunches) ? mark.extraPunches : [];
  for (const pair of extras) {
    if (!pair) continue;
    const exSeg = computeIntervalSec(dateStr, pair.in, pair.out, pair.inTs, pair.outTs, allowLive, nowMs);
    extraPunchesSec += exSeg.sec;
    if (exSeg.open) isWorkingNow = true;
    if (exSeg.crossedMidnight) crossedMidnight = true;
  }

  const dow = getDayOfWeek(dateStr);
  let normalCapSec = 0;
  if (dow === 0) {
    // Domingo: todo es hora extra (Código Laboral Paraguay)
    normalCapSec = 0;
  } else if (dow === 6) {
    normalCapSec = Math.max(0, (rules.sat ?? 4) * 3600);
  } else {
    normalCapSec = Math.max(0, (rules.wd ?? 8) * 3600);
  }

  const normSec = Math.min(baseWorkedSec, normalCapSec);
  const baseExtSec = Math.max(0, baseWorkedSec - normalCapSec);
  const extSec = baseExtSec + extraPunchesSec;
  const workedSec = normSec + extSec;

  return {
    workedSec,
    baseWorkedSec,
    normSec,
    baseExtSec,
    extraPunchesSec,
    extSec,
    isWorkingNow,
    crossedMidnight,
  };
}

export interface LegalLiquidationInput {
  hireDate: string;
  exitDate: string;
  monthlySalary: number;
  reason: 'despido_injustificado' | 'renuncia' | 'despido_justificado' | 'periodo_prueba' | 'otro';
  pendingDays: number;
  manualYearsWorked?: number;
  unpaidVacationDays: number;
  manualBonusGs?: number;
  applyIps: boolean;
}

export interface LegalLiquidationResult {
  totalDaysService: number;
  years: number;
  months: number;
  days: number;
  usedManualYears: boolean;
  dailyWage: number;
  pendingSalaryGs: number;
  aguinaldoGs: number;
  vacAnnualDays: number;
  vacPropDays: number;
  vacacionesGs: number;
  preavisoDays: number;
  preavisoGs: number;
  indemYearsCount: number;
  indemDays: number;
  indemnizacionGs: number;
  manualBonusGs: number;
  imponibleBaseGs: number;
  ipsDeductionGs: number;
  grossTotalGs: number;
  netTotalGs: number;
  isUnderSixMonths: boolean;
}

/**
 * Calculadora Legal de Liquidación Final e Indemnización según Código Laboral del Paraguay
 */
export function computeParaguayLegalLiquidation(inp: LegalLiquidationInput): LegalLiquidationResult {
  const [hy, hm, hd] = (inp.hireDate || todayStr()).split('-').map(Number);
  const [ey, em, ed] = (inp.exitDate || todayStr()).split('-').map(Number);
  const start = new Date(hy || 2026, (hm || 1) - 1, hd || 1);
  const end = new Date(ey || 2026, (em || 1) - 1, ed || 1);

  const diffMs = Math.max(0, end.getTime() - start.getTime());
  const dateDaysService = Math.floor(diffMs / 86400000);

  let years = end.getFullYear() - start.getFullYear();
  let months = end.getMonth() - start.getMonth();
  let days = end.getDate() - start.getDate();
  if (days < 0) {
    months -= 1;
    const prevMonthLastDay = new Date(end.getFullYear(), end.getMonth(), 0).getDate();
    days += prevMonthLastDay;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) {
    years = 0;
    months = 0;
    days = 0;
  }

  let totalDaysService = dateDaysService;
  const manualYrs = Number(inp.manualYearsWorked || 0);
  const usedManualYears = Number.isFinite(manualYrs) && manualYrs > 0;
  if (usedManualYears) {
    years = Math.floor(manualYrs);
    months = Math.round((manualYrs - years) * 12);
    if (months >= 12) {
      years += 1;
      months = 0;
    }
    days = 0;
    totalDaysService = Math.round(manualYrs * 365);
  }

  const totalMonths = years * 12 + months + days / 30;
  const isUnderSixMonths = totalMonths < 6;
  const salary = Math.max(0, inp.monthlySalary || 0);
  const dailyWage = salary / 30;

  // 1. Salario pendiente (imponible IPS)
  const pendingSalaryGs = Math.round(dailyWage * Math.max(0, inp.pendingDays || 0));

  // 2. Aguinaldo proporcional (1/12 de lo ganado en el año calendario actual, libre de IPS)
  const jan1 = new Date(end.getFullYear(), 0, 1);
  const agStart = usedManualYears && years >= 1 ? jan1 : start > jan1 ? start : jan1;
  const daysInYearWorked = Math.max(0, Math.floor((end.getTime() - agStart.getTime()) / 86400000) + 1);
  const earnedThisYear = (salary / 365) * Math.min(365, daysInYearWorked);
  const aguinaldoGs = Math.round(earnedThisYear / 12);

  // 3. Vacaciones causadas y proporcionales (Art. 218: 12, 18 o 30 días)
  let vacAnnualDays = 12;
  if (years > 10 || (years === 10 && (months > 0 || days > 0))) {
    vacAnnualDays = 30;
  } else if (years > 5 || (years === 5 && (months > 0 || days > 0))) {
    vacAnnualDays = 18;
  }
  const daysSinceLastAnniv = usedManualYears
    ? months > 0
      ? Math.round((months / 12) * 365)
      : dateDaysService % 365
    : totalDaysService % 365;
  const vacPropDays = Number(((vacAnnualDays * daysSinceLastAnniv) / 365).toFixed(2));
  const totalVacDays = Math.max(0, inp.unpaidVacationDays || 0) + vacPropDays;
  const vacacionesGs = Math.round(dailyWage * totalVacDays);

  // 4. Preaviso (Art. 87) & 5. Indemnización por antigüedad (Art. 91)
  // Si es nuevo (< 6 meses), renuncia, despido justificado o período de prueba: NO corresponde preaviso ni indemnización
  let preavisoDays = 0;
  let indemYearsCount = 0;
  let indemDays = 0;

  if (inp.reason === 'despido_injustificado' && !isUnderSixMonths) {
    if (years >= 10) preavisoDays = 90;
    else if (years >= 5) preavisoDays = 60;
    else if (years >= 1) preavisoDays = 45;
    else preavisoDays = 30;

    // 15 días por cada año de servicio o fracción > 6 meses
    const extraFractionYear = months > 6 || (months === 6 && days > 0) ? 1 : 0;
    indemYearsCount = Math.max(1, years + extraFractionYear);
    indemDays = indemYearsCount * 15;
  }

  const preavisoGs = Math.round(dailyWage * preavisoDays);
  const indemnizacionGs = Math.round(dailyWage * indemDays);
  const manualBonusGs = Math.max(0, Math.round(inp.manualBonusGs || 0));

  // 6. IPS 9% SOLO sobre conceptos imponibles (Salario pendiente + Vacaciones). Aguinaldo, Preaviso, Indemnización y viáticos están exentos.
  const imponibleBaseGs = pendingSalaryGs + vacacionesGs;
  const ipsDeductionGs = inp.applyIps ? Math.round(imponibleBaseGs * 0.09) : 0;

  const grossTotalGs = pendingSalaryGs + aguinaldoGs + vacacionesGs + preavisoGs + indemnizacionGs + manualBonusGs;
  const netTotalGs = Math.max(0, grossTotalGs - ipsDeductionGs);

  return {
    totalDaysService,
    years,
    months,
    days,
    usedManualYears,
    dailyWage,
    pendingSalaryGs,
    aguinaldoGs,
    vacAnnualDays,
    vacPropDays,
    vacacionesGs,
    preavisoDays,
    preavisoGs,
    indemYearsCount,
    indemDays,
    indemnizacionGs,
    manualBonusGs,
    imponibleBaseGs,
    ipsDeductionGs,
    grossTotalGs,
    netTotalGs,
    isUnderSixMonths,
  };
}

export function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || `id_${Date.now()}`;
}

export function generateEmployeeId(ci: string): string {
  const digits = ci.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  const suffix = Math.random().toString(36).slice(2, 7);
  return sanitizeId(`emp_${digits || 'u'}_${suffix}`);
}

export function generateDocId(prefix: string): string {
  return sanitizeId(`${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
}

export function makeMarkDocId(employeeId: string, dateStr: string): string {
  return sanitizeId(`${employeeId}_${dateStr}`);
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeCi(ci: string): string {
  return ci.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}

export function getMonthDates(monthStr: string, period: string): string[] {
  const [yStr, mStr] = monthStr.split('-');
  const y = Number(yStr) || new Date().getFullYear();
  const m = Number(mStr) || new Date().getMonth() + 1;
  const daysInMonth = new Date(y, m, 0).getDate();

  let start = 1;
  let end = daysInMonth;
  if (period === '1') {
    start = 1;
    end = Math.min(15, daysInMonth);
  } else if (period === '2') {
    start = 16;
    end = daysInMonth;
  }

  const dates: string[] = [];
  for (let day = start; day <= end; day++) {
    dates.push(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return dates;
}

export function getCurrentWeekDates(): string[] {
  const now = new Date();
  const dow = now.getDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return dates;
}

export async function compressImageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer la imagen'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Archivo de imagen inválido'));
      img.onload = () => {
        const maxDim = 220;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.max(1, Math.round(w * ratio));
          h = Math.max(1, Math.round(h * ratio));
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('No se pudo procesar la imagen'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        let dataUrl = canvas.toDataURL('image/webp', 0.82);
        if (!dataUrl.startsWith('data:image/webp') || dataUrl.length > SCHEMA_LIMITS.LOGO_MAX) {
          dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        }
        if (dataUrl.length > SCHEMA_LIMITS.LOGO_MAX) {
          reject(new Error('La imagen es demasiado grande incluso comprimida'));
          return;
        }
        resolve(dataUrl);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
