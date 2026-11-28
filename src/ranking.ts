import type { ReceiptDocument } from './receipts';
import type { AppState, EmployeeDoc, RankingDateFilter, RankingMode } from './types';
import { computeDayHours, escapeHtml, fmtGs, fmtHMS, fmtHoursDec, todayStr } from './utils';

export const RANKING_PALETTE = [
  '#2563eb', // Azul
  '#10b981', // Verde esmeralda
  '#f97316', // Naranja
  '#8b5cf6', // Violeta
  '#ef4444', // Rojo
  '#06b6d4', // Cian
  '#eab308', // Ámbar
  '#ec4899', // Rosa
  '#14b8a6', // Turquesa
  '#6366f1', // Índigo
  '#84cc16', // Lima
  '#d946ef', // Fucsia
];

export interface RankingItem {
  key: string;
  label: string;
  subLabel: string;
  color: string;
  normalSec: number;
  extraSec: number;
  previousBalance: number;
  subtotal: number;
  ips: number;
  total: number;
}

export interface RankingRange {
  from: string;
  to: string;
  periodLabel: string;
}

export function resolveRankingDateRange(
  filterMode: RankingDateFilter,
  fromVal: string,
  toVal: string,
  monthVal: string,
  yearVal: string
): RankingRange {
  const t = todayStr();
  if (filterMode === 'month') {
    const m = monthVal || t.slice(0, 7);
    const [yy, mm] = m.split('-').map(Number);
    const lastDay = yy && mm ? new Date(yy, mm, 0).getDate() : 31;
    const from = `${m}-01`;
    const to = `${m}-${String(lastDay).padStart(2, '0')}`;
    return { from, to, periodLabel: `Mes ${m}` };
  }
  if (filterMode === 'year') {
    const y = (yearVal || t.slice(0, 4)).slice(0, 4);
    return { from: `${y}-01-01`, to: `${y}-12-31`, periodLabel: `Año ${y}` };
  }
  const f = fromVal || `${t.slice(0, 7)}-01`;
  const end = toVal || t;
  const from = f <= end ? f : end;
  const to = f <= end ? end : f;
  return { from, to, periodLabel: `${from} al ${to}` };
}

function getAllRankingSectors(state: AppState, defaultSectors: string[]): string[] {
  const set = new Set<string>([...defaultSectors, ...(state.sectors || [])]);
  for (const e of state.employees) {
    if (e.sector) set.add(e.sector.trim());
  }
  for (const p of state.payrolls) {
    if (p.sector) set.add(p.sector.trim());
  }
  for (const ex of state.expenses) {
    if (ex.sector) set.add(ex.sector.trim());
  }
  return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

interface EmpAcc {
  normalSec: number;
  extraSec: number;
  previousBalance: number;
  subtotal: number;
  ips: number;
  total: number;
}

function emptyAcc(): EmpAcc {
  return {
    normalSec: 0,
    extraSec: 0,
    previousBalance: 0,
    subtotal: 0,
    ips: 0,
    total: 0,
  };
}

function computeEmployeePeriodMetrics(
  emp: EmployeeDoc,
  state: AppState,
  from: string,
  to: string,
  includeOpenMarks: boolean
): EmpAcc {
  const acc = emptyAcc();
  const t = todayStr();

  // 1. Sum all closed payroll liquidations in [from, to]
  for (const p of state.payrolls) {
    if (p.employeeId !== emp.id) continue;
    if (p.periodEnd < from || p.periodEnd > to) continue;
    acc.normalSec += p.normalSec || 0;
    acc.extraSec += p.extraSec || 0;
    acc.previousBalance += p.previousBalance || 0;
    acc.subtotal += (p.normalSubtotal || 0) + (p.extraSubtotal || 0);
    acc.ips += p.ipsDeduction || 0;
    acc.total += p.netTotal || 0;
  }

  // 2. Optionally include active unclosed marks in [from, to] (strictly after lastClosedDate to prevent double-counting)
  if (includeOpenMarks) {
    const lastClosed = emp.lastClosedDate || '';
    let openNormSec = 0;
    let openExtSec = 0;
    let hasOpenMarks = false;

    for (const mk of Object.values(state.marks)) {
      if (mk.employeeId !== emp.id) continue;
      if (mk.date < from || mk.date > to) continue;
      if (lastClosed && mk.date <= lastClosed) continue;
      const { normSec, extSec } = computeDayHours(mk, mk.date, state.rules, mk.date === t);
      if (normSec > 0 || extSec > 0) {
        openNormSec += normSec;
        openExtSec += extSec;
        hasOpenMarks = true;
      }
    }

    const carry = emp.carryOverBalance ?? 0;
    if (hasOpenMarks || (carry > 0 && to >= t)) {
      const rate = emp.hourlyRate ?? 15000;
      const otPct = emp.overtimePct ?? 50;
      const otRate = Math.round(rate * (1 + otPct / 100));
      const openNormSub = Math.round((openNormSec / 3600) * rate);
      const openExtSub = Math.round((openExtSec / 3600) * otRate);
      const openSub = openNormSub + openExtSub;
      const openPrev = to >= t ? carry : 0;

      acc.normalSec += openNormSec;
      acc.extraSec += openExtSec;
      acc.previousBalance += openPrev;
      acc.subtotal += openSub;
      acc.total += openSub + openPrev;
    }
  }

  return acc;
}

export function buildRankingUniverse(
  state: AppState,
  defaultSectors: string[],
  mode: RankingMode,
  from: string,
  to: string,
  includeOpenMarks: boolean
): RankingItem[] {
  if (mode === 'emp') {
    return state.employees.map((emp, idx) => {
      const m = computeEmployeePeriodMetrics(emp, state, from, to, includeOpenMarks);
      return {
        key: emp.id,
        label: emp.name,
        subLabel: emp.sector || 'General',
        color: RANKING_PALETTE[idx % RANKING_PALETTE.length],
        normalSec: m.normalSec,
        extraSec: m.extraSec,
        previousBalance: m.previousBalance,
        subtotal: m.subtotal,
        ips: m.ips,
        total: m.total,
      };
    });
  }

  // Sector mode
  const sectors = getAllRankingSectors(state, defaultSectors);
  const mapBySector = new Map<string, EmpAcc>();
  for (const s of sectors) {
    mapBySector.set(s, emptyAcc());
  }

  const knownEmpIds = new Set(state.employees.map((e) => e.id));

  // Aggregate per-employee metrics into their sector
  for (const emp of state.employees) {
    const sec = (emp.sector || 'General').trim();
    if (!mapBySector.has(sec)) mapBySector.set(sec, emptyAcc());
    const bucket = mapBySector.get(sec)!;
    const m = computeEmployeePeriodMetrics(emp, state, from, to, includeOpenMarks);
    bucket.normalSec += m.normalSec;
    bucket.extraSec += m.extraSec;
    bucket.previousBalance += m.previousBalance;
    bucket.subtotal += m.subtotal;
    bucket.ips += m.ips;
    bucket.total += m.total;
  }

  // Also include historical payrolls of deleted employees (if any) in their sector
  for (const p of state.payrolls) {
    if (knownEmpIds.has(p.employeeId)) continue;
    if (p.periodEnd < from || p.periodEnd > to) continue;
    const sec = (p.sector || 'General').trim();
    if (!mapBySector.has(sec)) mapBySector.set(sec, emptyAcc());
    const bucket = mapBySector.get(sec)!;
    bucket.normalSec += p.normalSec || 0;
    bucket.extraSec += p.extraSec || 0;
    bucket.previousBalance += p.previousBalance || 0;
    bucket.subtotal += (p.normalSubtotal || 0) + (p.extraSubtotal || 0);
    bucket.ips += p.ipsDeduction || 0;
    bucket.total += p.netTotal || 0;
  }

  const orderedSectors = Array.from(mapBySector.keys()).sort((a, b) => a.localeCompare(b));
  return orderedSectors.map((sec, idx) => {
    const m = mapBySector.get(sec)!;
    const empCount = state.employees.filter((e) => (e.sector || 'General').trim() === sec).length;
    return {
      key: sec,
      label: sec,
      subLabel: `${empCount} func.`,
      color: RANKING_PALETTE[idx % RANKING_PALETTE.length],
      normalSec: m.normalSec,
      extraSec: m.extraSec,
      previousBalance: m.previousBalance,
      subtotal: m.subtotal,
      ips: m.ips,
      total: m.total,
    };
  });
}

export function sortRankingItems(items: RankingItem[]): RankingItem[] {
  return [...items].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    const bHrs = b.normalSec + b.extraSec;
    const aHrs = a.normalSec + a.extraSec;
    if (bHrs !== aHrs) return bHrs - aHrs;
    return a.label.localeCompare(b.label);
  });
}

export function renderBarChartHtml(sortedSelected: RankingItem[]): string {
  if (!sortedSelected.length) {
    return `<div style="display:flex;align-items:center;justify-content:center;min-height:240px;color:#64748b;font-size:13px;text-align:center;padding:20px">
      Selecciona al menos un elemento en la lista izquierda para comparar ingresos.
    </div>`;
  }

  const maxVal = Math.max(1, ...sortedSelected.map((it) => it.total));
  const chartHeight = 200;

  const cols = sortedSelected
    .map((it) => {
      const pct = it.total > 0 ? Math.max(6, Math.round((it.total / maxVal) * 100)) : 2;
      const barPx = Math.max(6, Math.round((pct / 100) * chartHeight));
      return `<div class="rank-bar-col">
        <div class="rank-bar-val">${escapeHtml(fmtGs(it.total))}</div>
        <div class="rank-bar-track" style="height:${chartHeight}px">
          <div class="rank-bar-fill" style="height:${barPx}px;background:${it.color}" title="${escapeHtml(it.label)}: ${escapeHtml(fmtGs(it.total))}"></div>
        </div>
        <div class="rank-bar-name" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</div>
      </div>`;
    })
    .join('');

  return `<div class="rank-chart-wrap">${cols}</div>`;
}

export function renderRankingTableRows(sortedSelected: RankingItem[], mode: RankingMode): string {
  if (!sortedSelected.length) {
    return `<tr><td colspan="8" style="text-align:center;color:#64748b;padding:18px">Marca uno o más ${mode === 'emp' ? 'empleados' : 'sectores'} para ver el ranking.</td></tr>`;
  }

  let sumNorm = 0;
  let sumExt = 0;
  let sumPrev = 0;
  let sumSub = 0;
  let sumIps = 0;
  let sumTot = 0;

  const rows = sortedSelected.map((it, idx) => {
    sumNorm += it.normalSec;
    sumExt += it.extraSec;
    sumPrev += it.previousBalance;
    sumSub += it.subtotal;
    sumIps += it.ips;
    sumTot += it.total;

    const pos = idx + 1;
    const posClass =
      pos === 1 ? 'rank-pos rank-pos-1' : pos === 2 ? 'rank-pos rank-pos-2' : pos === 3 ? 'rank-pos rank-pos-3' : 'rank-pos';

    const displayName =
      mode === 'emp'
        ? `<strong>${escapeHtml(it.label)}</strong> <span style="color:#64748b;font-size:11px">(${escapeHtml(it.subLabel)})</span>`
        : `<strong>${escapeHtml(it.label)}</strong> <span style="color:#64748b;font-size:11px">(${escapeHtml(it.subLabel)})</span>`;

    return `<tr>
      <td><span class="${posClass}">#${pos}</span></td>
      <td><span class="rank-dot" style="background:${it.color}"></span>${displayName}</td>
      <td>${fmtHMS(it.normalSec)} <span style="color:#64748b;font-size:11px">(${fmtHoursDec(it.normalSec)})</span></td>
      <td style="color:#2563eb;font-weight:700">${fmtHMS(it.extraSec)} <span style="font-size:11px">(${fmtHoursDec(it.extraSec)})</span></td>
      <td>${escapeHtml(fmtGs(it.previousBalance))}</td>
      <td>${escapeHtml(fmtGs(it.subtotal))}</td>
      <td style="color:#dc2626">${escapeHtml(fmtGs(it.ips))}</td>
      <td style="font-weight:900;color:#16a34a">${escapeHtml(fmtGs(it.total))}</td>
    </tr>`;
  });

  rows.push(`<tr style="background:#f1f5f9;font-weight:800">
    <td colspan="2">TOTAL SELECCIONADOS (${sortedSelected.length})</td>
    <td>${fmtHMS(sumNorm)} (${fmtHoursDec(sumNorm)})</td>
    <td style="color:#2563eb">${fmtHMS(sumExt)} (${fmtHoursDec(sumExt)})</td>
    <td>${escapeHtml(fmtGs(sumPrev))}</td>
    <td>${escapeHtml(fmtGs(sumSub))}</td>
    <td style="color:#dc2626">${escapeHtml(fmtGs(sumIps))}</td>
    <td style="color:#0f172a;font-size:13px">${escapeHtml(fmtGs(sumTot))}</td>
  </tr>`);

  return rows.join('');
}

export function buildRankingReceiptDoc(
  sortedSelected: RankingItem[],
  mode: RankingMode,
  periodLabel: string,
  companyLogo: string
): ReceiptDocument {
  const modeLabel = mode === 'emp' ? 'Por Empleado' : 'Por Sector';
  const sumTot = sortedSelected.reduce((acc, it) => acc + it.total, 0);
  const sumSub = sortedSelected.reduce((acc, it) => acc + it.subtotal, 0);
  const sumIps = sortedSelected.reduce((acc, it) => acc + it.ips, 0);
  const sumPrev = sortedSelected.reduce((acc, it) => acc + it.previousBalance, 0);
  const sumNorm = sortedSelected.reduce((acc, it) => acc + it.normalSec, 0);
  const sumExt = sortedSelected.reduce((acc, it) => acc + it.extraSec, 0);

  const maxVal = Math.max(1, ...sortedSelected.map((it) => it.total));
  const barsHtml = sortedSelected
    .map((it) => {
      const w = it.total > 0 ? Math.max(4, Math.round((it.total / maxVal) * 100)) : 2;
      return `<div style="margin-bottom:7px">
        <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700;margin-bottom:2px">
          <span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${it.color};margin-right:5px"></span>${escapeHtml(it.label)}${mode === 'emp' ? ` (${escapeHtml(it.subLabel)})` : ''}</span>
          <span>${escapeHtml(fmtGs(it.total))}</span>
        </div>
        <div style="height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden">
          <div style="height:100%;width:${w}%;background:${it.color}"></div>
        </div>
      </div>`;
    })
    .join('');

  const rowsHtml = sortedSelected
    .map(
      (it, idx) => `<tr>
        <td style="font-weight:800">#${idx + 1}</td>
        <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${it.color};margin-right:5px"></span><strong>${escapeHtml(it.label)}</strong>${mode === 'emp' ? ` (${escapeHtml(it.subLabel)})` : ''}</td>
        <td>${fmtHoursDec(it.normalSec)}</td>
        <td>${fmtHoursDec(it.extraSec)}</td>
        <td style="text-align:right">${escapeHtml(fmtGs(it.previousBalance))}</td>
        <td style="text-align:right">${escapeHtml(fmtGs(it.subtotal))}</td>
        <td style="text-align:right">${escapeHtml(fmtGs(it.ips))}</td>
        <td style="text-align:right;font-weight:800">${escapeHtml(fmtGs(it.total))}</td>
      </tr>`
    )
    .join('');

  const bodyHtml = `
    <div style="margin-bottom:14px">
      <div style="font-size:12px;font-weight:800;margin-bottom:8px">Comparativa Visual de Ingresos (${escapeHtml(modeLabel)})</div>
      ${barsHtml || '<p style="color:#64748b">Sin datos seleccionados.</p>'}
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>${mode === 'emp' ? 'Empleado (Sector)' : 'Sector'}</th>
          <th>H. Norm.</th>
          <th>H. Ext.</th>
          <th style="text-align:right">Saldo Ant.</th>
          <th style="text-align:right">Subtotal</th>
          <th style="text-align:right">IPS (9%)</th>
          <th style="text-align:right">Total Cobrado</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        <tr style="background:#f1f5f9;font-weight:800">
          <td colspan="2">TOTAL (${sortedSelected.length})</td>
          <td>${fmtHoursDec(sumNorm)}</td>
          <td>${fmtHoursDec(sumExt)}</td>
          <td style="text-align:right">${escapeHtml(fmtGs(sumPrev))}</td>
          <td style="text-align:right">${escapeHtml(fmtGs(sumSub))}</td>
          <td style="text-align:right">${escapeHtml(fmtGs(sumIps))}</td>
          <td style="text-align:right">${escapeHtml(fmtGs(sumTot))}</td>
        </tr>
      </tbody>
    </table>`;

  const topLines = sortedSelected
    .slice(0, 12)
    .map((it, idx) => `#${idx + 1} ${it.label}${mode === 'emp' ? ` (${it.subLabel})` : ''}: ${fmtGs(it.total)} [Norm ${fmtHoursDec(it.normalSec)} | Ext ${fmtHoursDec(it.extraSec)}]`)
    .join('\n');

  const plainTextSummary =
    `CARL PETERS — RANKING & GRÁFICAS (${modeLabel})\n` +
    `Período: ${periodLabel}\n` +
    `${topLines || 'Sin registros seleccionados'}\n` +
    `TOTAL SELECCIONADOS: ${fmtGs(sumTot)}`;

  return {
    title: `RANKING & COMPARATIVA DE INGRESOS (${modeLabel.toUpperCase()})`,
    subtitle: `Período: ${periodLabel} • Ordenado de mayor a menor`,
    companyLogo,
    bodyHtml,
    plainTextSummary,
    showSignatures: true,
  };
}
