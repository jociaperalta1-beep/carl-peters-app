import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import QRCode from 'qrcode';
import { registerSW } from 'virtual:pwa-register';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  auth,
  BOOTSTRAPPED_ADMIN_EMAIL,
  db,
  handleFirestoreError,
  signInWithGoogle,
  signOutGoogle,
  testConnection,
} from './firebase';
import {
  buildRankingReceiptDoc,
  buildRankingUniverse,
  renderBarChartHtml,
  renderRankingTableRows,
  resolveRankingDateRange,
  sortRankingItems,
  type RankingItem,
} from './ranking';
import {
  buildWhatsappUrls,
  downloadReceiptHtmlForPdf,
  fmtGsRow,
  triggerPrintReceipt,
  type ReceiptDocument,
} from './receipts';
import {
  OperationType,
  type AdminTab,
  type AppState,
  type AttendanceMarkDoc,
  type AuthTab,
  type EmployeeDoc,
  type GpsHistoryDoc,
  type GpsLiveDoc,
  type GpsMode,
  type LayoutMode,
  type ManualExpenseDoc,
  type MapLayerMode,
  type MobSubTab,
  type PayrollLiquidationDoc,
  type RankingDateFilter,
  type RankingMode,
  type RememberedMobUser,
  type RrhhSubTab,
} from './types';
import {
  compressImageToDataUrl,
  computeDayHours,
  computeParaguayLegalLiquidation,
  currentMonthStr,
  currentYearStr,
  DEFAULT_SECTORS,
  escapeHtml,
  fmtGs,
  fmtHMS,
  fmtHoursDec,
  generateDocId,
  generateEmployeeId,
  getCurrentWeekDates,
  getMonthDates,
  makeMarkDocId,
  normalizeCi,
  nowTimeStr,
  SCHEMA_LIMITS,
  shiftDateStr,
  todayStr,
} from './utils';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface PulledSalaryContext {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  daysCount: number;
  normalSec: number;
  extraSec: number;
  previousBalance: number;
}

const MASTER_PIN = '5722677';
const ALT_ADMIN_PIN = '2026';
const DEFAULT_IPS_GS = 251848; // 9% del salario mínimo vigente PY (editable)
const CACHE_KEY = 'cp_py26_cache_v3';
const MOB_KEY = 'cp_py26_mob_id';
const MOB_REMEMBERED_KEY = 'cp_py26_mob_remembered_v1';
const ADM_KEY = 'cp_py26_adm_ok';
const LAYOUT_KEY = 'cp_py26_layout';

let mobRegHasIps = false;

type MarkSlot = 'e1' | 's2' | 'e3' | 's4';
let activeCalEdit: { empId: string; date: string; slot: MarkSlot } | null = null;

// === Ranking & Gráficas State ===
let rankMode: RankingMode = 'emp';
let rankDateFilter: RankingDateFilter = 'range';
const rankSelectedByMode: Record<RankingMode, Set<string>> = {
  emp: new Set<string>(),
  sector: new Set<string>(),
};
const rankKnownByMode: Record<RankingMode, Set<string>> = {
  emp: new Set<string>(),
  sector: new Set<string>(),
};
let lastRankingSorted: RankingItem[] = [];
let lastRankingPeriodLabel = '';

// === Application State ===
let currentUser: User | null = null;
let isCloudAdmin = false;
let fbConnected = false;
let unsubs: Unsubscribe[] = [];

let editId: string | null = null;
let gpsTimer: number | null = null;
let clockTimer: number | null = null;
let fpHoldTimer: number | null = null;
let fpHolding = false;
let lastCoords: { lat: number; lng: number; accuracy: number } | null = null;

// Pulled salary calculation cache
let pulledSalary: PulledSalaryContext = {
  employeeId: '',
  periodStart: todayStr(),
  periodEnd: todayStr(),
  daysCount: 0,
  normalSec: 0,
  extraSec: 0,
  previousBalance: 0,
};

// PWA Install & Share State
let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
let isPwaInstalled = false;
let isIOSDevice = false;
let pwaShareTarget: 'mobile' | 'full' = 'mobile';

// Leaflet map handles
let map: L.Map | null = null;
let satGrp: L.LayerGroup | null = null;
let osmLay: L.TileLayer | null = null;
let mkLay: L.LayerGroup | null = null;
let poly: L.Polyline | null = null;
let gpsMode: GpsMode = 'live';
let centeredOnce = false;

let state: AppState = loadLocalCache();

function loadLocalCache(): AppState {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppState>;
      return {
        companyLogo: typeof parsed.companyLogo === 'string' ? parsed.companyLogo : '',
        rules: {
          wd: typeof parsed.rules?.wd === 'number' ? parsed.rules.wd : 8,
          sat: typeof parsed.rules?.sat === 'number' ? parsed.rules.sat : 4,
        },
        sectors: Array.isArray(parsed.sectors) && parsed.sectors.length ? parsed.sectors : [...DEFAULT_SECTORS],
        employees: Array.isArray(parsed.employees) ? parsed.employees : [],
        marks: parsed.marks && typeof parsed.marks === 'object' ? parsed.marks : {},
        gpsLive: parsed.gpsLive && typeof parsed.gpsLive === 'object' ? parsed.gpsLive : {},
        payrolls: Array.isArray(parsed.payrolls) ? parsed.payrolls : [],
        expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      };
    }
  } catch {
    // Ignore corrupt cache
  }
  return {
    companyLogo: '',
    rules: { wd: 8, sat: 4 },
    sectors: [...DEFAULT_SECTORS],
    employees: [],
    marks: {},
    gpsLive: {},
    payrolls: [],
    expenses: [],
  };
}

function saveLocalCache(): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota errors
  }
}

function getAllSectors(): string[] {
  const set = new Set<string>([...DEFAULT_SECTORS, ...(state.sectors || [])]);
  for (const e of state.employees) {
    if (e.sector) set.add(e.sector.trim());
  }
  for (const ex of state.expenses) {
    if (ex.sector) set.add(ex.sector.trim());
  }
  return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

// === DOM Helpers ===
const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

// === Non-blocking Toast & Modal UI ===
function showToast(message: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  const host = $('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `cp-toast cp-toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 250);
  }, 3400);
}

interface ModalOptions {
  title: string;
  body: string;
  inputLabel?: string;
  inputPlaceholder?: string;
  inputType?: string;
  inputMaxLength?: number;
  defaultValue?: string;
  input2Label?: string;
  input2Placeholder?: string;
  input2Type?: string;
  input2MaxLength?: number;
  defaultValue2?: string;
  confirmText?: string;
  confirmClass?: string;
  cancelText?: string;
}

function openModal(opts: ModalOptions): Promise<string | [string, string] | boolean | null> {
  return new Promise((resolve) => {
    const overlay = $('cpModal');
    const titleEl = $('cpModalTitle');
    const bodyEl = $('cpModalBody');
    const inputWrap = $('cpModalInputWrap');
    const inputLbl = $('cpModalInputLbl');
    const inputEl = $<HTMLInputElement>('cpModalInput');
    const input2Wrap = $('cpModalInput2Wrap');
    const input2Lbl = $('cpModalInput2Lbl');
    const input2El = $<HTMLInputElement>('cpModalInput2');
    const okBtn = $<HTMLButtonElement>('cpModalOk');
    const cancelBtn = $<HTMLButtonElement>('cpModalCancel');

    if (
      !overlay || !titleEl || !bodyEl || !inputWrap || !inputLbl || !inputEl ||
      !input2Wrap || !input2Lbl || !input2El || !okBtn || !cancelBtn
    ) {
      resolve(null);
      return;
    }

    titleEl.textContent = opts.title;
    bodyEl.textContent = opts.body;
    okBtn.textContent = opts.confirmText || 'Confirmar';
    okBtn.className = `btn ${opts.confirmClass || 'btn-pri'}`;
    cancelBtn.textContent = opts.cancelText || 'Cancelar';

    const hasInput1 = Boolean(opts.inputLabel);
    const hasInput2 = Boolean(opts.input2Label);
    inputWrap.classList.toggle('hidden', !hasInput1);
    input2Wrap.classList.toggle('hidden', !hasInput2);

    if (hasInput1) {
      inputLbl.textContent = opts.inputLabel || '';
      inputEl.type = opts.inputType || 'text';
      inputEl.placeholder = opts.inputPlaceholder || '';
      inputEl.value = opts.defaultValue || '';
      if (opts.inputMaxLength) inputEl.maxLength = opts.inputMaxLength;
      else inputEl.removeAttribute('maxlength');
    }

    if (hasInput2) {
      input2Lbl.textContent = opts.input2Label || '';
      input2El.type = opts.input2Type || 'text';
      input2El.placeholder = opts.input2Placeholder || '';
      input2El.value = opts.defaultValue2 || '';
      if (opts.input2MaxLength) input2El.maxLength = opts.input2MaxLength;
      else input2El.removeAttribute('maxlength');
    }

    overlay.classList.remove('hidden');
    if (hasInput1) window.setTimeout(() => inputEl.focus(), 40);

    const submitVal = () => {
      if (hasInput1 && hasInput2) return [inputEl.value.trim(), input2El.value.trim()] as [string, string];
      if (hasInput1) return inputEl.value.trim();
      return true;
    };

    const cleanup = (val: string | [string, string] | boolean | null) => {
      overlay.classList.add('hidden');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      inputEl.onkeydown = null;
      input2El.onkeydown = null;
      resolve(val);
    };

    okBtn.onclick = () => cleanup(submitVal());
    cancelBtn.onclick = () => cleanup(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(submitVal());
      } else if (e.key === 'Escape') {
        cleanup(null);
      }
    };
    inputEl.onkeydown = onKey;
    input2El.onkeydown = onKey;
  });
}

// === PWA Install & Share Center ===
function getShareBaseOrigin(): string {
  const origin = window.location.origin;
  if (origin.includes('://ais-dev-')) {
    return origin.replace('://ais-dev-', '://ais-pre-');
  }
  return origin;
}

function getShareUrl(target: 'mobile' | 'full' = pwaShareTarget): string {
  const base = getShareBaseOrigin();
  return target === 'mobile' ? `${base}/?mode=mobile` : `${base}/`;
}

function updatePwaInstallButtons(): void {
  const mobBanner = $('mobInstallBanner');
  const mobIconAuth = $('mobInstallIconAuth');
  const mobIconApp = $('mobInstallIconApp');
  const installBtn = $('pwaInstallNowBtn');
  const hintEl = $('pwaInstallHint');
  const newTabLink = $<HTMLAnchorElement>('pwaOpenNewTab');

  if (mobBanner) {
    mobBanner.classList.toggle('hidden', isPwaInstalled);
    if (!isPwaInstalled) {
      if (deferredInstallPrompt) {
        mobBanner.textContent = '📲 Instalar App CARL PETERS en este Teléfono';
      } else if (isIOSDevice) {
        mobBanner.textContent = '📲 Cómo instalar en iPhone / iPad';
      } else {
        mobBanner.textContent = '📲 Instalar App / Compartir Enlace APK';
      }
    }
  }

  if (mobIconAuth) mobIconAuth.classList.toggle('hidden', isPwaInstalled);
  if (mobIconApp) mobIconApp.classList.toggle('hidden', isPwaInstalled);

  const inIframe = window.self !== window.top;
  if (newTabLink) {
    newTabLink.href = getShareUrl('mobile');
    newTabLink.classList.toggle('hidden', !inIframe || isPwaInstalled);
  }

  if (installBtn && hintEl) {
    if (isPwaInstalled) {
      installBtn.textContent = '✓ App ya instalada en este dispositivo';
      installBtn.className = 'btn btn-ok';
      hintEl.textContent = 'Esta aplicación ya se ejecuta como app instalada (modo independiente).';
    } else if (deferredInstallPrompt) {
      installBtn.textContent = '📲 Instalar App Ahora (1 toque)';
      installBtn.className = 'btn btn-ok';
      hintEl.textContent = 'Tu navegador está listo para instalar CARL PETERS como aplicación en la pantalla de inicio.';
    } else if (isIOSDevice) {
      installBtn.textContent = '📲 Ver pasos para instalar en iPhone / iPad';
      installBtn.className = 'btn btn-warn';
      hintEl.innerHTML =
        '<strong>En Safari (iPhone/iPad):</strong><br/>1. Toca el botón <strong>Compartir</strong>.<br/>2. Baja y elige <strong>Agregar a pantalla de inicio</strong>.<br/>3. Toca <strong>Agregar</strong>.';
    } else if (inIframe) {
      installBtn.textContent = '📲 Instalar desde pestaña principal';
      installBtn.className = 'btn btn-warn';
      hintEl.textContent =
        'En la vista previa embebida el navegador bloquea la instalación directa. Abre el enlace en una pestaña nueva o escanéalo desde el teléfono (Chrome/Edge → "Instalar aplicación").';
    } else {
      installBtn.textContent = '📲 Instalar en este Dispositivo';
      installBtn.className = 'btn btn-warn';
      hintEl.textContent =
        'En Android (Chrome): menú ⋮ → "Instalar aplicación". En iPhone (Safari): Compartir → "Agregar a pantalla de inicio".';
    }
  }
}

async function renderPwaShareContent(): Promise<void> {
  const url = getShareUrl(pwaShareTarget);
  const urlInput = $<HTMLInputElement>('pwaShareUrl');
  const waLink = $<HTMLAnchorElement>('pwaWaLink');
  const qrCanvas = $<HTMLCanvasElement>('pwaQrCanvas');
  const tMob = $('pwaTargetMob');
  const tFull = $('pwaTargetFull');
  const webShareBtn = $('pwaWebShareBtn');

  if (tMob) tMob.classList.toggle('active', pwaShareTarget === 'mobile');
  if (tFull) tFull.classList.toggle('active', pwaShareTarget === 'full');
  if (urlInput) urlInput.value = url;

  if (waLink) {
    const msg =
      pwaShareTarget === 'mobile'
        ? `CARL PETERS — App de Marcación de Obra:\nAbre este enlace en tu celular e instálala en la pantalla de inicio:\n${url}`
        : `CARL PETERS — Panel Web & Asistencia:\n${url}`;
    waLink.href = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  }

  if (webShareBtn) {
    webShareBtn.classList.toggle('hidden', typeof navigator.share !== 'function');
  }

  if (qrCanvas) {
    try {
      await QRCode.toCanvas(qrCanvas, url, {
        width: 168,
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
    } catch {
      // ignore
    }
  }
  updatePwaInstallButtons();
}

function setPwaShareTarget(target: 'mobile' | 'full'): void {
  pwaShareTarget = target;
  void renderPwaShareContent();
}

function openPwaShareModal(): void {
  const modal = $('pwaModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  void renderPwaShareContent();
}

function closePwaShareModal(): void {
  $('pwaModal')?.classList.add('hidden');
}

async function handleMobileInstallAction(): Promise<void> {
  if (deferredInstallPrompt) {
    await triggerPwaInstall();
    return;
  }
  openPwaShareModal();
}

async function triggerPwaInstall(): Promise<void> {
  if (isPwaInstalled) {
    showToast('La aplicación ya está instalada en este dispositivo', 'ok');
    return;
  }
  if (deferredInstallPrompt) {
    try {
      await deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        isPwaInstalled = true;
        deferredInstallPrompt = null;
        showToast('¡App CARL PETERS instalada correctamente!', 'ok');
      } else {
        showToast('Instalación cancelada', 'info');
      }
      updatePwaInstallButtons();
    } catch (err) {
      showToast(`Error al instalar: ${err instanceof Error ? err.message : 'reintenta'}`, 'err');
    }
    return;
  }
  if (isIOSDevice) {
    showToast('En Safari: toca Compartir y luego "Agregar a pantalla de inicio"', 'info');
    return;
  }
  showToast('Abre el enlace en Chrome/Edge móvil y elige "Instalar aplicación"', 'info');
}

async function copyPwaLink(): Promise<void> {
  const url = getShareUrl(pwaShareTarget);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const inp = $<HTMLInputElement>('pwaShareUrl');
      if (inp) {
        inp.select();
        document.execCommand('copy');
      }
    }
    showToast('Enlace copiado al portapapeles', 'ok');
  } catch {
    showToast('Selecciona y copia el enlace manualmente', 'info');
  }
}

async function sharePwaNative(): Promise<void> {
  if (typeof navigator.share !== 'function') {
    await copyPwaLink();
    return;
  }
  try {
    await navigator.share({
      title: 'CARL PETERS — App de Marcación',
      text: 'Instala la app CARL PETERS para marcar asistencia y GPS en obra:',
      url: getShareUrl(pwaShareTarget),
    });
  } catch {
    // cancelled
  }
}

function triggerFileDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
}

async function downloadInstallPackage(): Promise<void> {
  const mobileUrl = getShareUrl('mobile');
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      width: 240,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
  } catch {
    qrDataUrl = '';
  }

  const logoSrc = state.companyLogo || `${getShareBaseOrigin()}/icon-192.png`;
  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Instalar CARL PETERS — Marcación de Obra</title>
<style>body{margin:0;background:#0f172a;color:#0f172a;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}.card{background:#fff;border-radius:18px;max-width:400px;width:100%;padding:22px;text-align:center}.logo{height:60px;max-width:140px;object-fit:contain;margin:0 auto 10px;display:block}.btn{display:block;background:#2563eb;color:#fff;text-decoration:none;font-weight:800;padding:13px 16px;border-radius:10px;font-size:14px;margin-bottom:14px}.qr{width:200px;height:200px;margin:8px auto;display:block;border:1px solid #e2e8f0;border-radius:12px;padding:6px}.steps{text-align:left;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px;font-size:12px;line-height:1.55}</style>
</head><body><div class="card"><img class="logo" src="${escapeHtml(logoSrc)}" alt="CARL PETERS"/><h1>CARL PETERS — App del Personal</h1><a class="btn" href="${escapeHtml(mobileUrl)}">📲 Abrir e Instalar App de Marcación</a>${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR"/>` : ''}<div class="steps"><strong>Android (Chrome):</strong> Abre el enlace → Toca <strong>Instalar App</strong> o menú ⋮ → <em>Instalar aplicación</em>.<br/><br/><strong>iPhone (Safari):</strong> Abre en Safari → <strong>Compartir</strong> → <em>Agregar a pantalla de inicio</em>.</div></div></body></html>`;

  triggerFileDownload('CARL-PETERS-Instalar-APK.html', html, 'text/html;charset=utf-8');
  showToast('Paquete instalador descargado (CARL-PETERS-Instalar-APK.html)', 'ok');
}

function downloadPwaManifest(): void {
  const base = getShareBaseOrigin();
  const manifestObj = {
    id: '/',
    name: 'CARL PETERS — Asistencia & Nómina PY 2026',
    short_name: 'CARL PETERS',
    start_url: `${base}/?mode=mobile`,
    scope: `${base}/`,
    display: 'standalone',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      { src: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  triggerFileDownload('carl-peters-manifest.json', JSON.stringify(manifestObj, null, 2), 'application/manifest+json;charset=utf-8');
  showToast('Manifiesto PWA descargado', 'ok');
}

function initPwaListeners(): void {
  isPwaInstalled =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  isIOSDevice = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredInstallPrompt = e as BeforeInstallPromptEvent;
    updatePwaInstallButtons();
  });

  window.addEventListener('appinstalled', () => {
    isPwaInstalled = true;
    deferredInstallPrompt = null;
    updatePwaInstallButtons();
    showToast('¡CARL PETERS instalada en el dispositivo!', 'ok');
  });

  const syncOnline = () => {
    const bar = $('offlineBar');
    if (bar) bar.classList.toggle('hidden', navigator.onLine);
  };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();
  updatePwaInstallButtons();

  try {
    registerSW({ immediate: true });
  } catch {
    // non-critical
  }
}

// === Status & Auth UI ===
function updateConnectionBadges(): void {
  const fbBadge = $('fbBadge');
  const mobAuthLive = $('mobAuthLive');
  const mobLiveTag = $('mobLiveTag');
  const googleAuthBtn = $('googleAuthBtn');
  const mobGoogleCard = $('mobGoogleCard');
  const mobAuthCard = $('mobAuthCard');
  const mobGoogleEmail = $('mobGoogleEmail');
  const admGoogleStatus = $('admGoogleStatus');
  const signedInVerified = Boolean(currentUser && currentUser.emailVerified);

  if (fbBadge) {
    if (signedInVerified && fbConnected) {
      fbBadge.className = 'b-on';
      fbBadge.textContent = isCloudAdmin ? '● Firestore EN VIVO (Admin)' : '● Firestore EN VIVO';
    } else if (signedInVerified) {
      fbBadge.className = 'b-off';
      fbBadge.textContent = 'Sincronizando Firestore...';
    } else {
      fbBadge.className = 'b-off';
      fbBadge.textContent = '● Conectar Google para En Vivo';
    }
  }

  if (googleAuthBtn) {
    if (currentUser) {
      googleAuthBtn.textContent = `Salir Google (${currentUser.email?.split('@')[0] || 'cuenta'})`;
      googleAuthBtn.className = 'btn btn-dark';
    } else {
      googleAuthBtn.textContent = '🔐 Conectar Google';
      googleAuthBtn.className = 'btn btn-ok';
    }
  }

  if (admGoogleStatus) {
    if (currentUser) {
      admGoogleStatus.textContent = isCloudAdmin
        ? `Sesión Google Admin activa: ${currentUser.email}`
        : `Sesión Google activa: ${currentUser.email} (sin rol Admin en nube)`;
      admGoogleStatus.style.color = isCloudAdmin ? '#16a34a' : '#d97706';
    } else {
      admGoogleStatus.textContent = 'Inicia sesión con Google para sincronizar en vivo con Firestore.';
      admGoogleStatus.style.color = '#64748b';
    }
  }

  if (mobGoogleCard && mobAuthCard) {
    mobGoogleCard.classList.toggle('hidden', signedInVerified);
    mobAuthCard.classList.toggle('hidden', !signedInVerified);
  }
  if (mobGoogleEmail) mobGoogleEmail.textContent = currentUser?.email ? `Cuenta: ${currentUser.email}` : '';

  if (mobAuthLive) {
    mobAuthLive.className = signedInVerified ? 'live-tag on' : 'live-tag off';
    mobAuthLive.textContent = signedInVerified
      ? fbConnected ? '● EN VIVO • Firestore' : '● CONECTANDO...'
      : '● SIN CONEXIÓN (Conectar Google)';
  }
  if (mobLiveTag) {
    mobLiveTag.className = signedInVerified && fbConnected ? 'live-tag on' : 'live-tag off';
    mobLiveTag.textContent = signedInVerified && fbConnected
      ? isCloudAdmin ? '● EN VIVO • Admin / Simulador' : '● EN VIVO • Funcionario'
      : '● OFFLINE • Sin sincronización';
  }
}

async function handleGoogleAuthToggle(): Promise<void> {
  if (currentUser) {
    try {
      await signOutGoogle();
      showToast('Sesión de Google cerrada', 'info');
    } catch (err) {
      showToast(`Error al cerrar sesión: ${err instanceof Error ? err.message : String(err)}`, 'err');
    }
    return;
  }
  await triggerGoogleSignIn();
}

async function triggerGoogleSignIn(): Promise<void> {
  try {
    const user = await signInWithGoogle();
    showToast(`Conectado como ${user.email || 'usuario'}`, 'ok');
    if (user.email === BOOTSTRAPPED_ADMIN_EMAIL && user.emailVerified) {
      const wasLocked = localStorage.getItem(ADM_KEY) !== '1';
      localStorage.setItem(ADM_KEY, '1');
      syncAdminLockUI();
      if (wasLocked) openTab('portada');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('popup-closed-by-user')) {
      showToast(`No se pudo iniciar sesión con Google: ${msg}`, 'err');
    }
  }
}

// === Firestore Real-Time Subscriptions ===
function detachListeners(): void {
  for (const unsub of unsubs) {
    try {
      unsub();
    } catch {
      // ignore
    }
  }
  unsubs = [];
  fbConnected = false;
}

async function checkIsAdminUser(user: User): Promise<boolean> {
  if (!user.emailVerified) return false;
  if (user.email === BOOTSTRAPPED_ADMIN_EMAIL) return true;
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

async function attachFirestoreListeners(user: User): Promise<void> {
  detachListeners();
  isCloudAdmin = await checkIsAdminUser(user);
  updateConnectionBadges();

  // 1. Company Settings (/settings/company)
  unsubs.push(
    onSnapshot(
      doc(db, 'settings', 'company'),
      (snap) => {
        fbConnected = true;
        if (snap.exists()) {
          const d = snap.data();
          state.companyLogo = typeof d.companyLogo === 'string' ? d.companyLogo : '';
          state.rules = {
            wd: typeof d.wd === 'number' ? d.wd : 8,
            sat: typeof d.sat === 'number' ? d.sat : 4,
          };
          if (Array.isArray(d.sectors) && d.sectors.length) {
            state.sectors = d.sectors.filter((s): s is string => typeof s === 'string');
          }
          saveLocalCache();
          renderAll();
        }
        updateConnectionBadges();
      },
      (error) => handleFirestoreError(error, OperationType.GET, 'settings/company')
    )
  );

  // 2. Employees
  const empCol = collection(db, 'employees');
  const empByOwnerQ = isCloudAdmin ? empCol : query(empCol, where('ownerUid', '==', user.uid));
  let ownerEmps: EmployeeDoc[] = [];
  let emailEmps: EmployeeDoc[] = [];

  const mergeEmployees = () => {
    const mapById = new Map<string, EmployeeDoc>();
    for (const e of ownerEmps) mapById.set(e.id, e);
    for (const e of emailEmps) mapById.set(e.id, e);
    state.employees = Array.from(mapById.values()).sort((a, b) => a.name.localeCompare(b.name));
    saveLocalCache();
    renderAll();
  };

  unsubs.push(
    onSnapshot(
      empByOwnerQ,
      (snap) => {
        fbConnected = true;
        ownerEmps = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<EmployeeDoc, 'id'>) }));
        mergeEmployees();
        updateConnectionBadges();
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'employees')
    )
  );

  if (!isCloudAdmin && user.email) {
    unsubs.push(
      onSnapshot(
        query(empCol, where('email', '==', user.email)),
        (snap) => {
          emailEmps = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<EmployeeDoc, 'id'>) }));
          mergeEmployees();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'employees')
      )
    );
  }

  // 3. Attendance Marks
  const marksCol = collection(db, 'marks');
  const marksQ = isCloudAdmin ? marksCol : query(marksCol, where('ownerUid', '==', user.uid));
  unsubs.push(
    onSnapshot(
      marksQ,
      (snap) => {
        fbConnected = true;
        const nextMarks: Record<string, AttendanceMarkDoc> = {};
        snap.docs.forEach((d) => {
          nextMarks[d.id] = { id: d.id, ...(d.data() as Omit<AttendanceMarkDoc, 'id'>) };
        });
        state.marks = nextMarks;
        saveLocalCache();
        syncGlobalMarksDependents();
        updateConnectionBadges();
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'marks')
    )
  );

  // 4. Live GPS
  const gpsCol = collection(db, 'gpsLive');
  const gpsQ = isCloudAdmin ? gpsCol : query(gpsCol, where('ownerUid', '==', user.uid));
  unsubs.push(
    onSnapshot(
      gpsQ,
      (snap) => {
        fbConnected = true;
        const nextLive: Record<string, GpsLiveDoc> = {};
        snap.docs.forEach((d) => {
          nextLive[d.id] = d.data() as GpsLiveDoc;
        });
        state.gpsLive = nextLive;
        saveLocalCache();
        if (map && gpsMode === 'live') {
          void refreshGps(false);
        }
        updateConnectionBadges();
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'gpsLive')
    )
  );

  // 5. Payroll Liquidations
  const payCol = collection(db, 'payrolls');
  const payQ = isCloudAdmin ? payCol : query(payCol, where('ownerUid', '==', user.uid));
  unsubs.push(
    onSnapshot(
      payQ,
      (snap) => {
        fbConnected = true;
        state.payrolls = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<PayrollLiquidationDoc, 'id'>) }))
          .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
        saveLocalCache();
        renderPayrollHistory();
        renderExtractos();
        renderCal();
        renderRanking();
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'payrolls')
    )
  );

  // 6. Immutable Manual Expenses (Admin only)
  if (isCloudAdmin) {
    unsubs.push(
      onSnapshot(
        collection(db, 'expenses'),
        (snap) => {
          fbConnected = true;
          state.expenses = snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<ManualExpenseDoc, 'id'>) }))
            .sort((a, b) => b.date.localeCompare(a.date));
          saveLocalCache();
          renderSectorDropdowns();
          renderExpenses();
          renderExtractos();
          renderRanking();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'expenses')
      )
    );
  }
}

// === Branding & Direct Mobile Logo Picker ===
function applyBrandingAndRules(): void {
  const logo = state.companyLogo || '/icon-192.png';
  const topLogo = $<HTMLImageElement>('topLogo');
  const cfgLogo = $<HTMLImageElement>('cfgLogo');
  const mobAuthLogo = $<HTMLImageElement>('mobAuthLogo');
  const mobHeadLogo = $<HTMLImageElement>('mobHeadLogo');

  if (topLogo) topLogo.src = logo;
  if (cfgLogo) cfgLogo.src = logo;
  if (mobAuthLogo) mobAuthLogo.src = logo;
  if (mobHeadLogo) mobHeadLogo.src = logo;

  const wdEl = $<HTMLInputElement>('cfgWd');
  const satEl = $<HTMLInputElement>('cfgSat');
  if (wdEl && document.activeElement !== wdEl) wdEl.value = String(state.rules.wd);
  if (satEl && document.activeElement !== satEl) satEl.value = String(state.rules.sat);
}

function openMobileLogoPicker(): void {
  if (!currentUser || !currentUser.emailVerified) {
    showToast('Conecta tu cuenta Google Admin para cambiar el logo en vivo', 'info');
    void triggerGoogleSignIn();
    return;
  }
  if (!isCloudAdmin) {
    showToast('Solo el Administrador puede actualizar el logo en Firestore', 'err');
    return;
  }
  const picker = $<HTMLInputElement>('mobLogoPicker');
  if (picker) {
    picker.value = '';
    picker.click();
  }
}

function renderSectorDropdowns(): void {
  const sectors = getAllSectors();
  const dl = $('sectorDatalist');
  if (dl) {
    dl.innerHTML = sectors.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');
  }

  const expSec = $<HTMLSelectElement>('expSector');
  if (expSec) {
    const prev = expSec.value;
    expSec.innerHTML = sectors.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (prev && sectors.includes(prev)) expSec.value = prev;
  }

  const expFilterSec = $<HTMLSelectElement>('expFilterSector');
  if (expFilterSec) {
    const prev = expFilterSec.value;
    expFilterSec.innerHTML =
      `<option value="ALL">Todos los sectores</option>` +
      sectors.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (prev) expFilterSec.value = prev;
  }

  const extSec = $<HTMLSelectElement>('extSector');
  if (extSec) {
    const prev = extSec.value;
    extSec.innerHTML =
      `<option value="ALL">Todos los sectores</option>` +
      sectors.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (prev) extSec.value = prev;
  }
}

async function addCustomSector(): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Conecta Google Admin para agregar sectores', 'err');
    return;
  }
  const val = await openModal({
    title: 'Agregar Nuevo Sector / Camión',
    body: 'Escribe el nombre del nuevo sector, área o camión (ej. Camión Volvo 02, Estancia Norte).',
    inputLabel: 'Nombre del Sector',
    inputPlaceholder: 'Ej. Camión Scania 01',
    inputMaxLength: SCHEMA_LIMITS.SECTOR_MAX,
    confirmText: 'Agregar Sector',
  });
  if (typeof val !== 'string' || !val.trim()) return;
  const clean = val.trim().slice(0, SCHEMA_LIMITS.SECTOR_MAX);
  const nextSectors = Array.from(new Set([...getAllSectors(), clean])).slice(0, SCHEMA_LIMITS.SECTORS_MAX);
  try {
    await setDoc(doc(db, 'settings', 'company'), {
      companyLogo: state.companyLogo || '',
      wd: state.rules.wd,
      sat: state.rules.sat,
      sectors: nextSectors,
      updatedAt: serverTimestamp(),
    });
    state.sectors = nextSectors;
    renderSectorDropdowns();
    const expSec = $<HTMLSelectElement>('expSector');
    if (expSec) expSec.value = clean;
    showToast(`Sector "${clean}" agregado`, 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'settings/company');
    showToast('No se pudo guardar el sector', 'err');
  }
}

// === Animated Initial Admin Cover (Smooth Straight Left-to-Right Loop) ===
let currentAdminTab: AdminTab = 'portada';
let coverRafId: number | null = null;
let coverLastTs = 0;
let coverInitialized = false;
let coverX = 0;
const COVER_SPEED_PX_PER_SEC = 105;

function stopCoverAnimation(): void {
  if (coverRafId !== null) {
    window.cancelAnimationFrame(coverRafId);
    coverRafId = null;
  }
  coverLastTs = 0;
}

function applyCoverTransform(): void {
  const titleEl = $('coverMarqueeTitle');
  if (!titleEl) return;
  titleEl.style.transform = `translate3d(${coverX.toFixed(2)}px, -50%, 0)`;
}

function startCoverAnimation(): void {
  const adminPanel = $('adminPanel');
  const tabPortada = $('tab-portada');
  const stage = $('coverStage');
  const titleEl = $('coverMarqueeTitle');
  if (!adminPanel || !tabPortada || !stage || !titleEl) return;
  if (adminPanel.classList.contains('hidden') || tabPortada.classList.contains('hidden')) {
    stopCoverAnimation();
    return;
  }

  if (!coverInitialized) {
    const titleW = titleEl.offsetWidth || 320;
    coverX = -titleW;
    coverInitialized = true;
  }
  applyCoverTransform();

  if (coverRafId !== null) return;
  coverLastTs = 0;

  const step = (ts: number) => {
    const adm = $('adminPanel');
    const port = $('tab-portada');
    const stg = $('coverStage');
    const ttl = $('coverMarqueeTitle');
    if (!adm || !port || !stg || !ttl || adm.classList.contains('hidden') || port.classList.contains('hidden')) {
      stopCoverAnimation();
      return;
    }

    if (coverLastTs === 0) coverLastTs = ts;
    const dt = Math.min(0.05, Math.max(0, (ts - coverLastTs) / 1000));
    coverLastTs = ts;

    const stageW = stg.clientWidth;
    const titleW = ttl.offsetWidth || 320;

    coverX += COVER_SPEED_PX_PER_SEC * dt;
    if (coverX > stageW) {
      coverX = -titleW;
    }

    ttl.style.transform = `translate3d(${coverX.toFixed(2)}px, -50%, 0)`;
    coverRafId = window.requestAnimationFrame(step);
  };

  coverRafId = window.requestAnimationFrame(step);
}

window.addEventListener('resize', () => {
  if (currentAdminTab === 'portada') applyCoverTransform();
});

// === Layout & Admin Navigation ===
function setLayout(mode: LayoutMode): void {
  const ws = $('ws');
  const adminLock = $('adminLock');
  const adminPanel = $('adminPanel');
  const mobCol = $('mobCol');

  document.body.classList.toggle('mob-only', mode === 'mobile');
  localStorage.setItem(LAYOUT_KEY, mode);

  const bAdm = $('btnModeAdmin');
  const bBoth = $('btnModeBoth');
  const bMob = $('btnModeMobile');
  if (bAdm) bAdm.className = mode === 'admin' ? 'btn btn-pri' : 'btn btn-out';
  if (bBoth) bBoth.className = mode === 'both' ? 'btn btn-pri' : 'btn btn-out';
  if (bMob) bMob.className = mode === 'mobile' ? 'btn btn-pri' : 'btn btn-out';

  if (!ws || !adminLock || !adminPanel || !mobCol) return;
  const isAdmOpen = localStorage.getItem(ADM_KEY) === '1';

  if (mode === 'admin') {
    ws.style.gridTemplateColumns = '1fr';
    mobCol.classList.add('hidden');
    adminLock.classList.toggle('hidden', isAdmOpen);
    adminPanel.classList.toggle('hidden', !isAdmOpen);
  } else if (mode === 'both') {
    ws.style.gridTemplateColumns = 'minmax(0, 1fr) 390px';
    mobCol.classList.remove('hidden');
    adminLock.classList.toggle('hidden', isAdmOpen);
    adminPanel.classList.toggle('hidden', !isAdmOpen);
  } else {
    ws.style.gridTemplateColumns = '1fr';
    mobCol.classList.remove('hidden');
  }

  if (isAdmOpen && mode !== 'mobile' && currentAdminTab === 'portada') {
    window.setTimeout(() => startCoverAnimation(), 40);
  } else {
    stopCoverAnimation();
  }

  if (map) window.setTimeout(() => map?.invalidateSize(), 120);
}

function syncAdminLockUI(): void {
  const mode = (localStorage.getItem(LAYOUT_KEY) as LayoutMode) || 'both';
  setLayout(document.body.classList.contains('mob-only') ? 'mobile' : mode);
}

function loginAdmin(event: Event): void {
  event.preventDefault();
  const pass = $<HTMLInputElement>('admPass')?.value.trim() || '';
  if (pass === MASTER_PIN || pass === ALT_ADMIN_PIN) {
    localStorage.setItem(ADM_KEY, '1');
    const passInput = $<HTMLInputElement>('admPass');
    if (passInput) passInput.value = '';
    syncAdminLockUI();
    openTab('portada');
    renderAll();
    showToast(currentUser ? 'Panel Admin desbloqueado' : 'Admin abierto. Conecta Google para sincronizar en vivo.', currentUser ? 'ok' : 'info');
  } else {
    showToast('Clave / PIN de administrador incorrecto', 'err');
  }
}

function logoutAdmin(): void {
  localStorage.removeItem(ADM_KEY);
  stopCoverAnimation();
  syncAdminLockUI();
  showToast('Sesión de administrador bloqueada', 'info');
}

async function unlockAdminPin(): Promise<void> {
  const val = await openModal({
    title: 'Acceso Administrador',
    body: 'Ingresa el PIN maestro para abrir el panel de administración.',
    inputLabel: 'PIN Administrador',
    inputType: 'password',
    inputPlaceholder: '5722677 o 2026',
    inputMaxLength: 10,
    confirmText: 'Desbloquear',
  });
  if (typeof val !== 'string') return;
  if (val === MASTER_PIN || val === ALT_ADMIN_PIN) {
    localStorage.setItem(ADM_KEY, '1');
    setLayout('both');
    openTab('portada');
    renderAll();
    showToast('Modo Administrador activado', 'ok');
  } else {
    showToast('PIN incorrecto', 'err');
  }
}

function openAdminCover(): void {
  if (localStorage.getItem(ADM_KEY) !== '1') return;
  openTab('portada');
}

function openTab(tab: AdminTab): void {
  currentAdminTab = tab;
  document.querySelectorAll<HTMLElement>('.adm-tab').forEach((el) => {
    el.classList.toggle('hidden', el.id !== `tab-${tab}`);
  });
  document.querySelectorAll<HTMLButtonElement>('.side .nav[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  if (tab === 'portada') {
    window.setTimeout(() => startCoverAnimation(), 20);
    return;
  }

  stopCoverAnimation();

  if (tab === 'rrhh') {
    onPayEmpChange();
    recalcLegalLive();
    renderExtractos();
    renderExpenses();
  } else if (tab === 'cal') {
    renderCal();
  } else if (tab === 'gps') {
    initGpsMapIfNeeded();
    window.setTimeout(() => {
      map?.invalidateSize();
      void refreshGps(true);
    }, 100);
  } else if (tab === 'rank') {
    renderRanking();
  }
}

function openRrhhSub(sub: RrhhSubTab): void {
  document.querySelectorAll<HTMLElement>('.rrhh-sub').forEach((el) => {
    el.classList.toggle('hidden', el.id !== `rsub-${sub}`);
  });
  document.querySelectorAll<HTMLButtonElement>('.sub-btn[data-rsub]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.rsub === sub);
  });
  if (sub === 'pago') recalcSalaryLive();
  else if (sub === 'legal') recalcLegalLive();
  else if (sub === 'ext') renderExtractos();
  else if (sub === 'gastos') renderExpenses();
}

// === Admin Tab 1: Hoy ===
function renderHoy(): void {
  const body = $('hoyBody');
  const countEl = $('hoyCount');
  if (!body) return;

  const t = todayStr();
  let present = 0;

  const rows = state.employees.map((emp) => {
    const mk = state.marks[makeMarkDocId(emp.id, t)];
    if (mk && (mk.e1 || mk.e3)) present++;
    const { normSec, extSec, isWorkingNow } = computeDayHours(mk, t, state.rules, true);
    const liveDot = isWorkingNow ? ' <span style="color:#16a34a;font-weight:800">●</span>' : '';
    return `<tr>
      <td><strong>${escapeHtml(emp.name)}</strong>${liveDot}</td>
      <td>${escapeHtml(emp.ci)}</td>
      <td>${escapeHtml(emp.sector)}</td>
      <td>${escapeHtml(mk?.e1 || '—')}</td>
      <td>${escapeHtml(mk?.s2 || '—')}</td>
      <td>${escapeHtml(mk?.e3 || '—')}</td>
      <td>${escapeHtml(mk?.s4 || '—')}</td>
      <td>${fmtHMS(normSec)}</td>
      <td style="color:#2563eb;font-weight:700">${fmtHMS(extSec)}</td>
    </tr>`;
  });

  if (countEl) countEl.textContent = `${t} • Presentes: ${present} / ${state.employees.length}`;
  body.innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="9" style="text-align:center;color:#64748b;padding:18px">Sin funcionarios registrados aún. Crea uno en Empleados o desde el celular.</td></tr>`;
}

// === Admin Tab 3: Empleados (Separado y Desplegable) ===
function toggleRegEmpBox(): void {
  const body = $('regEmpBody');
  const lbl = $('regEmpToggleLbl');
  if (!body || !lbl) return;
  const nowHidden = body.classList.toggle('hidden');
  lbl.textContent = nowHidden ? 'Mostrar formulario ▼' : 'Ocultar formulario ▲';
}

function renderEmployees(): void {
  const body = $('empBody');
  const countBadge = $('empCountBadge');
  const empList = $('empList');
  const calEmp = $<HTMLSelectElement>('calEmp');
  const gpsEmp = $<HTMLSelectElement>('gpsEmp');
  const payEmp = $<HTMLSelectElement>('payEmp');
  const legEmp = $<HTMLSelectElement>('legEmp');

  if (countBadge) countBadge.textContent = `${state.employees.length} registrados`;

  if (body) {
    body.innerHTML = state.employees.length
      ? state.employees
          .map((e) => {
            const rate = e.hourlyRate ?? 15000;
            const ot = e.overtimePct ?? 50;
            const hasIps = Boolean(e.hasIps);
            const ipsAmt = Math.max(0, Number(e.ipsAmount || 0));
            const ipsHtml = hasIps
              ? `<span class="pill-ok">CON IPS</span><div style="font-size:10px;color:#15803d;font-weight:700;margin-top:2px">${fmtGs(ipsAmt)}</div>`
              : `<span class="pill-gray">SIN IPS</span>`;
            const resetBadge = e.pinResetEnabled
              ? ` <span class="pill-warn">Reset activo</span>`
              : '';
            return `<tr>
              <td><strong>${escapeHtml(e.name)}</strong>${resetBadge}${e.email ? `<div style="font-size:10px;color:#64748b">${escapeHtml(e.email)}</div>` : ''}</td>
              <td>${escapeHtml(e.ci)}</td>
              <td>${escapeHtml(e.sector)}</td>
              <td>${ipsHtml}</td>
              <td>${escapeHtml(e.hireDate || '—')}</td>
              <td>${fmtGs(rate)} <span style="color:#2563eb;font-size:11px">(+${ot}%)</span></td>
              <td><code>${escapeHtml(e.pin)}</code></td>
              <td>
                <div style="display:flex;gap:4px;flex-wrap:wrap">
                  <button type="button" class="btn btn-out btn-sm" data-edit-emp="${escapeHtml(e.id)}">Editar</button>
                  <button type="button" class="btn btn-warn btn-sm" data-reset-emp="${escapeHtml(e.id)}">Resetear PIN</button>
                  <button type="button" class="btn btn-err btn-sm" data-del-emp="${escapeHtml(e.id)}">Eliminar</button>
                </div>
              </td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="8" style="text-align:center;color:#64748b;padding:14px">No hay empleados registrados.</td></tr>`;

    body.querySelectorAll<HTMLButtonElement>('[data-edit-emp]').forEach((btn) => {
      btn.onclick = () => btn.dataset.editEmp && openEmpEdit(btn.dataset.editEmp);
    });
    body.querySelectorAll<HTMLButtonElement>('[data-reset-emp]').forEach((btn) => {
      btn.onclick = () => btn.dataset.resetEmp && void resetEmpPinById(btn.dataset.resetEmp);
    });
    body.querySelectorAll<HTMLButtonElement>('[data-del-emp]').forEach((btn) => {
      btn.onclick = () => btn.dataset.delEmp && void deleteEmpById(btn.dataset.delEmp);
    });
  }

  if (empList) {
    empList.innerHTML = state.employees
      .map((e) => `<option value="${escapeHtml(e.ci)}">${escapeHtml(e.name)} (${escapeHtml(e.sector)})</option>`)
      .join('');
  }

  const syncSelect = (sel: HTMLSelectElement | null, includeAll = false) => {
    if (!sel) return;
    const prev = sel.value;
    const opts = state.employees.map(
      (e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)} — ${escapeHtml(e.ci)} (${escapeHtml(e.sector)})</option>`
    );
    sel.innerHTML = includeAll
      ? `<option value="ALL">Todos los funcionarios</option>` + opts.join('')
      : opts.length ? opts.join('') : `<option value="">Sin empleados</option>`;
    if (prev && (prev === 'ALL' || state.employees.some((e) => e.id === prev))) {
      sel.value = prev;
    }
  };

  syncSelect(calEmp, false);
  syncSelect(gpsEmp, true);
  syncSelect(payEmp, false);
  syncSelect(legEmp, false);
  syncSelect($<HTMLSelectElement>('addHrEmp'), false);
}

function onNewEmpIpsToggle(): void {
  const hasIps = $<HTMLSelectElement>('newEmpHasIps')?.value === '1';
  const amtEl = $<HTMLInputElement>('newEmpIpsAmt');
  if (!amtEl) return;
  if (!hasIps) {
    amtEl.value = '0';
  } else if (!Number(amtEl.value)) {
    amtEl.value = String(DEFAULT_IPS_GS);
  }
}

function onEdEmpIpsToggle(): void {
  const hasIps = $<HTMLSelectElement>('edHasIps')?.value === '1';
  const amtEl = $<HTMLInputElement>('edIpsAmt');
  if (!amtEl) return;
  if (!hasIps) {
    amtEl.value = '0';
  } else if (!Number(amtEl.value)) {
    amtEl.value = String(DEFAULT_IPS_GS);
  }
}

async function saveNewEmployee(): Promise<void> {
  if (!currentUser || !currentUser.emailVerified) {
    showToast('Conecta tu cuenta Google primero para guardar en Firestore', 'err');
    return;
  }
  const name = ($<HTMLInputElement>('newEmpName')?.value || '').trim().slice(0, SCHEMA_LIMITS.NAME_MAX);
  const ci = ($<HTMLInputElement>('newEmpCi')?.value || '').trim().slice(0, SCHEMA_LIMITS.CI_MAX);
  const sector = (($<HTMLInputElement>('newEmpSec')?.value || '').trim() || 'Ganado').slice(0, SCHEMA_LIMITS.SECTOR_MAX);
  const pin = ($<HTMLInputElement>('newEmpPin')?.value || '').trim();
  const hireDate = ($<HTMLInputElement>('newEmpHireDate')?.value || todayStr()).trim();
  const hourlyRate = Math.max(0, Number($<HTMLInputElement>('newEmpRate')?.value) || 15000);
  const overtimePct = Math.min(500, Math.max(0, Number($<HTMLInputElement>('newEmpOtPct')?.value) || 50));
  const hasIps = $<HTMLSelectElement>('newEmpHasIps')?.value === '1';
  const ipsAmount = hasIps ? Math.min(100000000, Math.max(0, Math.round(Number($<HTMLInputElement>('newEmpIpsAmt')?.value) || 0))) : 0;
  const email = ($<HTMLInputElement>('newEmpEmail')?.value || '').trim().toLowerCase().slice(0, SCHEMA_LIMITS.EMAIL_MAX);

  if (!name || !ci) {
    showToast('Completa Nombre y C.I.', 'err');
    return;
  }
  if (!SCHEMA_LIMITS.PIN_PATTERN.test(pin)) {
    showToast('El PIN debe tener exactamente 4 dígitos numéricos', 'err');
    return;
  }
  if (state.employees.some((e) => normalizeCi(e.ci) === normalizeCi(ci))) {
    showToast('Ya existe un funcionario con esa C.I.', 'err');
    return;
  }

  const empId = generateEmployeeId(ci);
  const payload = {
    name,
    ci,
    ciNormalized: normalizeCi(ci),
    sector,
    pin,
    hireDate: SCHEMA_LIMITS.DATE_PATTERN.test(hireDate) ? hireDate : todayStr(),
    hourlyRate,
    overtimePct,
    hasIps,
    ipsAmount,
    lastClosedDate: '',
    carryOverBalance: 0,
    pinResetEnabled: false,
    ownerUid: currentUser.uid,
    email: isCloudAdmin ? email : currentUser.email || '',
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'employees', empId), payload);
    const clearIds = ['newEmpName', 'newEmpCi', 'newEmpEmail'];
    clearIds.forEach((id) => {
      const el = $<HTMLInputElement>(id);
      if (el) el.value = '';
    });
    const hasIpsSel = $<HTMLSelectElement>('newEmpHasIps');
    const ipsAmtEl = $<HTMLInputElement>('newEmpIpsAmt');
    if (hasIpsSel) hasIpsSel.value = '0';
    if (ipsAmtEl) ipsAmtEl.value = '0';
    showToast(`Funcionario ${name} registrado en Firestore`, 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `employees/${empId}`);
    showToast('Error al guardar funcionario (verifica permisos de Admin)', 'err');
  }
}

function openEmpEdit(id: string): void {
  const emp = state.employees.find((e) => e.id === id);
  if (!emp) return;
  editId = id;
  $('empEditBox')?.classList.remove('hidden');
  const setVal = (elId: string, val: string) => {
    const el = $<HTMLInputElement>(elId);
    if (el) el.value = val;
  };
  setVal('edName', emp.name);
  setVal('edCi', emp.ci);
  setVal('edSec', emp.sector);
  setVal('edPin', emp.pin);
  setVal('edHireDate', emp.hireDate || todayStr());
  setVal('edRate', String(emp.hourlyRate ?? 15000));
  setVal('edOtPct', String(emp.overtimePct ?? 50));
  const edHasIps = $<HTMLSelectElement>('edHasIps');
  if (edHasIps) edHasIps.value = emp.hasIps ? '1' : '0';
  setVal('edIpsAmt', String(emp.hasIps ? emp.ipsAmount ?? 0 : 0));
  setVal('edEmail', emp.email || '');
}

function closeEmpEdit(): void {
  editId = null;
  $('empEditBox')?.classList.add('hidden');
}

async function applyEmpEdit(): Promise<void> {
  if (!editId || !currentUser) return;
  const name = ($<HTMLInputElement>('edName')?.value || '').trim().slice(0, SCHEMA_LIMITS.NAME_MAX);
  const ci = ($<HTMLInputElement>('edCi')?.value || '').trim().slice(0, SCHEMA_LIMITS.CI_MAX);
  const sector = ($<HTMLInputElement>('edSec')?.value || '').trim().slice(0, SCHEMA_LIMITS.SECTOR_MAX);
  const pin = ($<HTMLInputElement>('edPin')?.value || '').trim();
  const hireDate = ($<HTMLInputElement>('edHireDate')?.value || '').trim();
  const hourlyRate = Math.max(0, Number($<HTMLInputElement>('edRate')?.value) || 0);
  const overtimePct = Math.min(500, Math.max(0, Number($<HTMLInputElement>('edOtPct')?.value) || 50));
  const hasIps = $<HTMLSelectElement>('edHasIps')?.value === '1';
  const ipsAmount = hasIps ? Math.min(100000000, Math.max(0, Math.round(Number($<HTMLInputElement>('edIpsAmt')?.value) || 0))) : 0;
  const email = ($<HTMLInputElement>('edEmail')?.value || '').trim().toLowerCase().slice(0, SCHEMA_LIMITS.EMAIL_MAX);

  if (!name || !ci || !sector || !SCHEMA_LIMITS.PIN_PATTERN.test(pin)) {
    showToast('Revisa Nombre, C.I., Sector y PIN (4 dígitos)', 'err');
    return;
  }

  try {
    const patch: Record<string, unknown> = isCloudAdmin
      ? {
          name,
          ci,
          ciNormalized: normalizeCi(ci),
          sector,
          pin,
          hireDate: SCHEMA_LIMITS.DATE_PATTERN.test(hireDate) ? hireDate : '',
          hourlyRate,
          overtimePct,
          hasIps,
          ipsAmount,
          email,
          updatedAt: serverTimestamp(),
        }
      : { name, sector, pin, updatedAt: serverTimestamp() };
    await updateDoc(doc(db, 'employees', editId), patch);
    closeEmpEdit();
    showToast('Cambios guardados en Firestore', 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `employees/${editId}`);
    showToast('No se pudieron guardar los cambios', 'err');
  }
}

async function resetEmpPinById(targetId: string): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Solo el Administrador puede habilitar el reseteo de PIN', 'err');
    return;
  }
  const emp = state.employees.find((e) => e.id === targetId);
  const newPin = await openModal({
    title: `Resetear PIN — ${emp?.name || 'Empleado'}`,
    body: 'Ingresa un PIN temporal de 4 dígitos. Además se habilitará la recuperación en la nube por C.I. para que el funcionario pueda crear su propio PIN si cambió de celular.',
    inputLabel: 'PIN temporal (4 dígitos)',
    inputType: 'text',
    inputPlaceholder: '1234',
    defaultValue: '1234',
    inputMaxLength: 4,
    confirmText: 'Resetear y Habilitar Recuperación',
    confirmClass: 'btn-warn',
  });
  if (typeof newPin !== 'string') return;
  if (!SCHEMA_LIMITS.PIN_PATTERN.test(newPin)) {
    showToast('El PIN debe tener exactamente 4 dígitos', 'err');
    return;
  }
  try {
    await updateDoc(doc(db, 'employees', targetId), {
      pin: newPin,
      pinResetEnabled: true,
      ciNormalized: normalizeCi(emp?.ci || ''),
      updatedAt: serverTimestamp(),
    });
    if (editId === targetId) {
      const edPin = $<HTMLInputElement>('edPin');
      if (edPin) edPin.value = newPin;
    }
    showToast(`PIN reseteado a ${newPin} y recuperación en nube habilitada`, 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `employees/${targetId}`);
    showToast('Error al resetear PIN', 'err');
  }
}

async function resetEmpPin(): Promise<void> {
  if (editId) await resetEmpPinById(editId);
}

async function deleteEmpById(targetId: string): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Solo el Administrador puede eliminar empleados', 'err');
    return;
  }
  const emp = state.employees.find((e) => e.id === targetId);
  const ok = await openModal({
    title: 'Eliminar Empleado',
    body: `¿Seguro que deseas eliminar a ${emp?.name || 'este empleado'} (C.I. ${emp?.ci || '—'}) de la base de datos?`,
    confirmText: 'Sí, Eliminar',
    confirmClass: 'btn-err',
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(db, 'employees', targetId));
    try {
      await deleteDoc(doc(db, 'gpsLive', targetId));
    } catch {
      // optional
    }
    if (localStorage.getItem(MOB_KEY) === targetId) {
      localStorage.removeItem(MOB_KEY);
      stopGpsLoop();
    }
    if (editId === targetId) closeEmpEdit();
    showToast('Empleado eliminado', 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `employees/${targetId}`);
    showToast('Error al eliminar empleado', 'err');
  }
}

async function deleteEmp(): Promise<void> {
  if (editId) await deleteEmpById(editId);
}

// === RRHH SUB 1: PAGO DE SALARIO (LADO A LADO + CIERRE DE PERÍODO) ===
function syncPayIpsFromEmployee(emp: EmployeeDoc | undefined): void {
  const ipsChk = $<HTMLInputElement>('payApplyIps');
  const ipsInput = $<HTMLInputElement>('payIpsInput');
  if (!emp) {
    if (ipsChk) ipsChk.checked = false;
    if (ipsInput) ipsInput.value = '0';
    return;
  }
  const hasIps = Boolean(emp.hasIps);
  const empIpsGs = hasIps ? Math.max(0, Math.round(Number(emp.ipsAmount ?? 0))) : 0;
  if (ipsChk) ipsChk.checked = hasIps;
  if (ipsInput) ipsInput.value = String(empIpsGs);
}

function onPayEmpChange(): void {
  const empId = $<HTMLSelectElement>('payEmp')?.value || '';
  const emp = state.employees.find((e) => e.id === empId);
  if (!emp) return;
  const rateEl = $<HTMLInputElement>('payRate');
  const otEl = $<HTMLInputElement>('payOtPct');
  if (rateEl) rateEl.value = String(emp.hourlyRate ?? 15000);
  if (otEl) otEl.value = String(emp.overtimePct ?? 50);
  syncPayIpsFromEmployee(emp);
  pullHoursSinceLastClose(true);
}

function onPayApplyIpsToggle(): void {
  const checked = Boolean($<HTMLInputElement>('payApplyIps')?.checked);
  const ipsInput = $<HTMLInputElement>('payIpsInput');
  if (!ipsInput) {
    recalcSalaryLive();
    return;
  }
  if (!checked) {
    ipsInput.value = '0';
  } else {
    const empId = $<HTMLSelectElement>('payEmp')?.value || '';
    const emp = state.employees.find((e) => e.id === empId);
    const savedAmt = Math.max(0, Math.round(Number(emp?.ipsAmount ?? 0)));
    if (savedAmt > 0) {
      ipsInput.value = String(savedAmt);
    } else {
      // If employee has no fixed Gs. amount yet, suggest 9% of current worked subtotal (or default IPS)
      const hourlyRate = Math.max(0, Number($<HTMLInputElement>('payRate')?.value) || 0);
      const overtimePct = Math.min(500, Math.max(0, Number($<HTMLInputElement>('payOtPct')?.value) || 0));
      const extraUnitRate = hourlyRate * (1 + overtimePct / 100);
      const sub =
        Math.round((pulledSalary.normalSec / 3600) * hourlyRate) +
        Math.round((pulledSalary.extraSec / 3600) * extraUnitRate);
      ipsInput.value = String(sub > 0 ? Math.round(sub * 0.09) : DEFAULT_IPS_GS);
    }
  }
  recalcSalaryLive();
}

function onPayIpsManualInput(): void {
  const val = Math.max(0, Math.round(Number($<HTMLInputElement>('payIpsInput')?.value) || 0));
  const ipsChk = $<HTMLInputElement>('payApplyIps');
  if (ipsChk) ipsChk.checked = val > 0;
  recalcSalaryLive();
}

function clearSalaryForm(): void {
  const t = todayStr();
  pulledSalary = {
    employeeId: '',
    periodStart: t,
    periodEnd: t,
    daysCount: 0,
    normalSec: 0,
    extraSec: 0,
    previousBalance: 0,
  };
  const setVal = (id: string, val: string) => {
    const el = $<HTMLInputElement>(id);
    if (el) el.value = val;
  };
  setVal('payRate', '0');
  setVal('payOtPct', '50');
  setVal('payIpsInput', '0');
  const ipsChk = $<HTMLInputElement>('payApplyIps');
  if (ipsChk) ipsChk.checked = false;
  const rangeInfo = $('payRangeInfo');
  if (rangeInfo) rangeInfo.textContent = 'Formulario limpio. Selecciona un funcionario y presiona "Estirar Horas desde Último Cierre".';
  const periodBadge = $('payPeriodBadge');
  if (periodBadge) {
    periodBadge.textContent = 'Limpio / Listo';
    periodBadge.className = 'pill-blue';
  }
  recalcSalaryLive();
  showToast('Pantalla de Pago de Salario limpia', 'info');
}

function pullHoursSinceLastClose(silent = false): void {
  const empId = $<HTMLSelectElement>('payEmp')?.value || '';
  const emp = state.employees.find((e) => e.id === empId);
  if (!emp) {
    if (!silent) showToast('Selecciona un funcionario primero', 'err');
    return;
  }

  const lastClosed = emp.lastClosedDate || '';
  const today = todayStr();

  // Gather all marks strictly after lastClosedDate up to today
  const openMarks = Object.values(state.marks)
    .filter((m) => m.employeeId === emp.id && (!lastClosed || m.date > lastClosed) && m.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  let normalSec = 0;
  let extraSec = 0;
  let daysCount = 0;

  for (const mk of openMarks) {
    const { workedSec, normSec, extSec } = computeDayHours(mk, mk.date, state.rules, mk.date === today);
    if (workedSec > 0) {
      daysCount++;
      normalSec += normSec;
      extraSec += extSec;
    }
  }

  const periodStart = openMarks.length
    ? openMarks[0].date
    : lastClosed
      ? shiftDateStr(lastClosed, 1)
      : today;

  // Detect previous balance: stored carryOverBalance
  const storedCarry = Number(emp.carryOverBalance || 0);

  pulledSalary = {
    employeeId: emp.id,
    periodStart,
    periodEnd: today,
    daysCount,
    normalSec,
    extraSec,
    previousBalance: storedCarry,
  };

  // Auto-pull employee's IPS status & Gs. amount (CON IPS -> emp.ipsAmount; SIN IPS -> 0)
  syncPayIpsFromEmployee(emp);

  const rangeInfo = $('payRangeInfo');
  const periodBadge = $('payPeriodBadge');
  if (rangeInfo) {
    rangeInfo.textContent = lastClosed
      ? `Desde último cierre (${lastClosed}) → ${periodStart} al ${today} • ${daysCount} día(s) con marcaciones`
      : `Sin cierres previos → ${periodStart} al ${today} • ${daysCount} día(s) con marcaciones`;
  }
  if (periodBadge) {
    periodBadge.textContent = daysCount > 0 ? `Planilla Activa (${daysCount} días)` : 'Al día / 0h pendientes';
    periodBadge.className = daysCount > 0 ? 'pill-warn' : 'pill-ok';
  }

  recalcSalaryLive();
  if (!silent) {
    const ipsMsg = emp.hasIps ? ` • IPS: ${fmtGs(emp.ipsAmount ?? 0)}` : ' • SIN IPS';
    showToast(`Horas estiradas: ${fmtHoursDec(normalSec)} norm. + ${fmtHoursDec(extraSec)} extras${ipsMsg}`, 'ok');
  }
}

function getCurrentSalaryCalc() {
  const empId = $<HTMLSelectElement>('payEmp')?.value || '';
  const emp = state.employees.find((e) => e.id === empId) || null;
  const hourlyRate = Math.max(0, Number($<HTMLInputElement>('payRate')?.value) || 0);
  const overtimePct = Math.min(500, Math.max(0, Number($<HTMLInputElement>('payOtPct')?.value) || 0));
  const ipsInputVal = Math.max(0, Math.round(Number($<HTMLInputElement>('payIpsInput')?.value) || 0));
  const applyIps = Boolean($<HTMLInputElement>('payApplyIps')?.checked) && ipsInputVal > 0;

  const ctx =
    pulledSalary.employeeId && pulledSalary.employeeId === empId
      ? pulledSalary
      : {
          employeeId: empId,
          periodStart: todayStr(),
          periodEnd: todayStr(),
          daysCount: 0,
          normalSec: 0,
          extraSec: 0,
          previousBalance: pulledSalary.employeeId === '' ? 0 : Number(emp?.carryOverBalance || 0),
        };

  const extraUnitRate = hourlyRate * (1 + overtimePct / 100);
  const normalSubtotal = Math.round((ctx.normalSec / 3600) * hourlyRate);
  const extraSubtotal = Math.round((ctx.extraSec / 3600) * extraUnitRate);
  const gross = normalSubtotal + extraSubtotal + ctx.previousBalance;
  const ipsDeduction = applyIps ? ipsInputVal : 0;
  const netTotal = Math.max(0, gross - ipsDeduction);

  return {
    emp,
    ...ctx,
    hourlyRate,
    overtimePct,
    extraUnitRate,
    normalSubtotal,
    extraSubtotal,
    ipsDeduction,
    applyIps,
    netTotal,
  };
}

function recalcSalaryLive(): void {
  const c = getCurrentSalaryCalc();
  const setTxt = (id: string, val: string) => {
    const el = $(id);
    if (el) el.textContent = val;
  };
  setTxt('payOtPctLbl', String(c.overtimePct));
  setTxt('payNormHrs', `${fmtHMS(c.normalSec)} (${fmtHoursDec(c.normalSec)})`);
  setTxt('payNormUnit', fmtGs(c.hourlyRate));
  setTxt('payNormSub', fmtGs(c.normalSubtotal));
  setTxt('payExtHrs', `${fmtHMS(c.extraSec)} (${fmtHoursDec(c.extraSec)})`);
  setTxt('payExtUnit', fmtGs(c.extraUnitRate));
  setTxt('payExtSub', fmtGs(c.extraSubtotal));
  setTxt('payPrevBal', fmtGs(c.previousBalance));
  setTxt('payIpsVal', c.ipsDeduction > 0 ? `- ${fmtGs(c.ipsDeduction)}` : '0 Gs.');
  setTxt('payNetTotal', fmtGs(c.netTotal));

  const ipsBadge = $('payIpsBadge');
  if (ipsBadge) {
    const isCon = Boolean(c.emp?.hasIps) || c.ipsDeduction > 0;
    ipsBadge.textContent = isCon ? 'CON IPS' : 'SIN IPS';
    ipsBadge.className = isCon ? 'pill-ok' : 'pill-gray';
  }

  const receipt = buildSalaryReceiptDoc();
  const wa = buildWhatsappUrls(receipt.plainTextSummary);
  const waSup = $<HTMLAnchorElement>('payWaSupport');
  const waAny = $<HTMLAnchorElement>('payWaAny');
  if (waSup) waSup.href = wa.supportUrl;
  if (waAny) waAny.href = wa.anyContactUrl;
}

async function liquidateAndClosePeriod(): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Solo el Administrador conectado con Google puede liquidar y cerrar períodos', 'err');
    return;
  }
  const c = getCurrentSalaryCalc();
  if (!c.emp) {
    showToast('Selecciona un funcionario', 'err');
    return;
  }
  const ok = await openModal({
    title: `Liquidar y Cerrar Período — ${c.emp.name}`,
    body: `Se registrará el pago por ${fmtGs(c.netTotal)} (${c.periodStart} al ${c.periodEnd}), Descuento IPS: ${fmtGs(c.ipsDeduction)}, se dejará el Saldo Anterior en 0 Gs. y se cerrarán estas fechas en Calendario & PDF.`,
    confirmText: '✅ Confirmar Liquidación y Cierre',
    confirmClass: 'btn-ok',
  });
  if (!ok) return;

  const payrollId = generateDocId('pay');
  const summaryText = `Liquidación salarial ${c.periodStart} al ${c.periodEnd} (${c.daysCount} días). Norm: ${fmtHoursDec(c.normalSec)} × ${fmtGs(c.hourlyRate)}. Ext: ${fmtHoursDec(c.extraSec)} × ${fmtGs(c.extraUnitRate)} (+${c.overtimePct}%). IPS: ${fmtGs(c.ipsDeduction)}.`;

  try {
    await setDoc(doc(db, 'payrolls', payrollId), {
      type: 'salary',
      employeeId: c.emp.id,
      ownerUid: c.emp.ownerUid || currentUser.uid,
      empName: c.emp.name,
      empCi: c.emp.ci,
      sector: c.emp.sector,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      daysCount: c.daysCount,
      normalSec: c.normalSec,
      extraSec: c.extraSec,
      hourlyRate: c.hourlyRate,
      overtimePct: c.overtimePct,
      normalSubtotal: c.normalSubtotal,
      extraSubtotal: c.extraSubtotal,
      previousBalance: c.previousBalance,
      ipsDeduction: c.ipsDeduction,
      netTotal: c.netTotal,
      ipsApplied: c.applyIps,
      summary: summaryText.slice(0, SCHEMA_LIMITS.SUMMARY_MAX),
      createdAt: serverTimestamp(),
    });

    await updateDoc(doc(db, 'employees', c.emp.id), {
      lastClosedDate: c.periodEnd,
      carryOverBalance: 0,
      hourlyRate: c.hourlyRate,
      overtimePct: c.overtimePct,
      updatedAt: serverTimestamp(),
    });

    showToast(`✓ Período cerrado hasta ${c.periodEnd}. Saldo Anterior = 0 Gs.`, 'ok');
    window.setTimeout(() => pullHoursSinceLastClose(true), 300);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `payrolls/${payrollId}`);
    showToast('Error al liquidar y cerrar período en Firestore', 'err');
  }
}

function buildSalaryReceiptDoc(): ReceiptDocument {
  const c = getCurrentSalaryCalc();
  const empName = c.emp?.name || 'Funcionario';
  const empCi = c.emp?.ci || '—';
  const sector = c.emp?.sector || '—';
  const bodyHtml = `
    <p style="font-size:12px;margin-bottom:8px">
      <strong>Funcionario:</strong> ${escapeHtml(empName)} &nbsp;|&nbsp;
      <strong>C.I.:</strong> ${escapeHtml(empCi)} &nbsp;|&nbsp;
      <strong>Sector:</strong> ${escapeHtml(sector)}<br/>
      <strong>Período liquidado:</strong> ${escapeHtml(c.periodStart)} al ${escapeHtml(c.periodEnd)} (${c.daysCount} días con marcación)
    </p>
    <table>
      <thead><tr><th>Concepto</th><th style="text-align:right">Importe (Gs.)</th></tr></thead>
      <tbody>
        ${fmtGsRow(`Horas Normales: ${fmtHMS(c.normalSec)} (${fmtHoursDec(c.normalSec)}) × ${fmtGs(c.hourlyRate)}/h`, c.normalSubtotal)}
        ${fmtGsRow(`Horas Extras (+${c.overtimePct}%): ${fmtHMS(c.extraSec)} (${fmtHoursDec(c.extraSec)}) × ${fmtGs(c.extraUnitRate)}/h`, c.extraSubtotal)}
        ${fmtGsRow('Saldo Anterior Pendiente', c.previousBalance)}
        ${fmtGsRow(c.ipsDeduction > 0 ? 'Descuento IPS' : 'Descuento IPS (SIN IPS)', -c.ipsDeduction)}
        ${fmtGsRow('TOTAL NETO A PAGAR', c.netTotal, true)}
      </tbody>
    </table>`;
  const plainTextSummary = `CARL PETERS — Recibo de Salario\nFuncionario: ${empName} (C.I. ${empCi})\nSector: ${sector}\nPeríodo: ${c.periodStart} al ${c.periodEnd}\n• Normales (${fmtHoursDec(c.normalSec)}): ${fmtGs(c.normalSubtotal)}\n• Extras +${c.overtimePct}% (${fmtHoursDec(c.extraSec)}): ${fmtGs(c.extraSubtotal)}\n• Saldo Anterior: ${fmtGs(c.previousBalance)}\n• Descuento IPS: -${fmtGs(c.ipsDeduction)}\nTOTAL NETO: ${fmtGs(c.netTotal)}`;
  return {
    title: 'RECIBO OFICIAL DE LIQUIDACIÓN DE SALARIO',
    subtitle: `${empName} — C.I. ${empCi} (${sector})`,
    companyLogo: state.companyLogo,
    bodyHtml,
    plainTextSummary,
    showSignatures: true,
  };
}

function printSalaryReceipt(): void {
  triggerPrintReceipt(buildSalaryReceiptDoc());
}

function downloadSalaryPdf(): void {
  const c = getCurrentSalaryCalc();
  const slug = (c.emp?.name || 'salario').replace(/[^a-zA-Z0-9]+/g, '_');
  downloadReceiptHtmlForPdf(`Recibo_Salario_${slug}_${todayStr()}.html`, buildSalaryReceiptDoc());
  showToast('Recibo listo para guardar como PDF (abre el archivo y presiona Imprimir / Guardar PDF)', 'ok');
}

function renderPayrollHistory(): void {
  const body = $('payHistBody');
  if (!body) return;
  const rows = state.payrolls.slice(0, 20).map((p) => `<tr>
    <td>${escapeHtml(p.periodStart)} → ${escapeHtml(p.periodEnd)} <span class="pill-ok">${p.type === 'legal' ? 'Legal' : 'Salario'}</span></td>
    <td><strong>${escapeHtml(p.empName)}</strong></td>
    <td>${escapeHtml(p.sector)}</td>
    <td>${fmtGs(p.normalSubtotal)}</td>
    <td>${fmtGs(p.extraSubtotal)}</td>
    <td style="color:#dc2626">${p.ipsDeduction > 0 ? `- ${fmtGs(p.ipsDeduction)}` : '0 Gs.'}</td>
    <td><strong>${fmtGs(p.netTotal)}</strong></td>
  </tr>`);
  body.innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="7" style="text-align:center;color:#64748b;padding:14px">Sin liquidaciones cerradas todavía.</td></tr>`;
}

// === RRHH SUB 2: CALCULADORA LEGAL PARAGUAY ===
interface LegalExtraConcept {
  id: string;
  concept: string;
  amount: number;
}

let legalExtraCounter = 1;
let legalExtraConcepts: LegalExtraConcept[] = [{ id: 'leg_c_1', concept: '', amount: 0 }];

function renderLegalExtraRows(): void {
  const tbody = $('legExtraBody');
  if (!tbody) return;
  tbody.innerHTML = legalExtraConcepts
    .map((item, idx) => {
      const label = idx === 0 ? '6. Concepto Manual (Comisión / Viático)' : `6.${idx + 1}. Concepto Adicional`;
      const removeBtn =
        legalExtraConcepts.length > 1
          ? `<button type="button" class="btn btn-err btn-sm no-print" style="padding:4px 7px" data-leg-remove="${escapeHtml(item.id)}" title="Quitar fila">✕</button>`
          : '';
      return `<tr style="background:#f8fafc">
        <td><strong>${label}</strong></td>
        <td>
          <input type="text" maxlength="80" placeholder="Ej. Comisión, Viático, Bonificación" value="${escapeHtml(item.concept)}" data-leg-concept="${escapeHtml(item.id)}"/>
        </td>
        <td style="text-align:right">
          <div style="display:inline-flex;align-items:center;justify-content:flex-end;gap:6px">
            <input type="number" min="0" step="1000" value="${item.amount}" data-leg-amount="${escapeHtml(item.id)}" style="width:140px;text-align:right;font-weight:800;color:#15803d" aria-label="Monto manual en guaraníes"/>
            ${removeBtn}
          </div>
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll<HTMLInputElement>('[data-leg-concept]').forEach((inp) => {
    inp.oninput = () => {
      const row = legalExtraConcepts.find((r) => r.id === inp.dataset.legConcept);
      if (row) {
        row.concept = inp.value.slice(0, 80);
        recalcLegalLive();
      }
    };
  });

  tbody.querySelectorAll<HTMLInputElement>('[data-leg-amount]').forEach((inp) => {
    inp.oninput = () => {
      const row = legalExtraConcepts.find((r) => r.id === inp.dataset.legAmount);
      if (row) {
        row.amount = Math.max(0, Math.round(Number(inp.value) || 0));
        recalcLegalLive();
      }
    };
  });

  tbody.querySelectorAll<HTMLButtonElement>('[data-leg-remove]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.legRemove || '';
      if (id) removeLegalConceptRow(id);
    };
  });
}

function addLegalConceptRow(): void {
  legalExtraCounter += 1;
  const newId = `leg_c_${legalExtraCounter}`;
  legalExtraConcepts.push({ id: newId, concept: '', amount: 0 });
  renderLegalExtraRows();
  recalcLegalLive();
  const newInput = document.querySelector<HTMLInputElement>(`[data-leg-concept="${newId}"]`);
  if (newInput) newInput.focus();
}

function removeLegalConceptRow(id: string): void {
  legalExtraConcepts = legalExtraConcepts.filter((r) => r.id !== id);
  if (!legalExtraConcepts.length) {
    legalExtraCounter += 1;
    legalExtraConcepts = [{ id: `leg_c_${legalExtraCounter}`, concept: '', amount: 0 }];
  }
  renderLegalExtraRows();
  recalcLegalLive();
}

function onLegReasonChange(): void {
  const reason = $<HTMLSelectElement>('legReason')?.value || 'despido_injustificado';
  const customEl = $<HTMLInputElement>('legCustomReason');
  if (customEl) {
    const isOther = reason === 'otro';
    customEl.classList.toggle('hidden', !isOther);
    if (isOther) customEl.focus();
  }
  recalcLegalLive();
}

function onLegEmpChange(): void {
  const empId = $<HTMLSelectElement>('legEmp')?.value || '';
  const emp = state.employees.find((e) => e.id === empId);
  if (!emp) return;
  const hireEl = $<HTMLInputElement>('legHireDate');
  const salEl = $<HTMLInputElement>('legSalary');
  const pendEl = $<HTMLInputElement>('legPendingDays');
  const ipsEl = $<HTMLInputElement>('legApplyIps');

  if (hireEl) hireEl.value = emp.hireDate || todayStr();
  if (salEl && emp.hourlyRate) {
    // Estimated monthly wage (208h/month or minimum wage if lower)
    salEl.value = String(Math.max(2798309, Math.round(emp.hourlyRate * 208)));
  }
  if (ipsEl) {
    ipsEl.checked = Boolean(emp.hasIps);
  }
  // Connect with unclosed attendance days from Pago de Salario (marks strictly after lastClosedDate)
  if (pendEl) {
    const lastClosed = emp.lastClosedDate || '';
    const today = todayStr();
    const openWorkedDays = Object.values(state.marks).filter((m) => {
      if (m.employeeId !== emp.id) return false;
      if (lastClosed && m.date <= lastClosed) return false;
      if (m.date > today) return false;
      return computeDayHours(m, m.date, state.rules, m.date === today).workedSec > 0;
    }).length;
    pendEl.value = String(Math.min(31, openWorkedDays));
  }
  recalcLegalLive();
}

function clearLegalForm(): void {
  const t = todayStr();
  const setVal = (id: string, val: string) => {
    const el = $<HTMLInputElement>(id);
    if (el) el.value = val;
  };
  setVal('legHireDate', t);
  setVal('legExitDate', t);
  setVal('legSalary', '0');
  setVal('legPendingDays', '0');
  setVal('legUnpaidVac', '0');
  setVal('legCustomReason', '');
  const reasonEl = $<HTMLSelectElement>('legReason');
  if (reasonEl) reasonEl.value = 'despido_injustificado';
  $<HTMLInputElement>('legCustomReason')?.classList.add('hidden');

  legalExtraCounter += 1;
  legalExtraConcepts = [{ id: `leg_c_${legalExtraCounter}`, concept: '', amount: 0 }];
  renderLegalExtraRows();

  const ipsEl = $<HTMLInputElement>('legApplyIps');
  if (ipsEl) ipsEl.checked = false;
  recalcLegalLive();
  showToast('Pantalla de Liquidación Legal limpia', 'info');
}

function getCurrentLegalCalc() {
  const empId = $<HTMLSelectElement>('legEmp')?.value || '';
  const emp = state.employees.find((e) => e.id === empId) || null;
  const hireDate = $<HTMLInputElement>('legHireDate')?.value || emp?.hireDate || todayStr();
  const exitDate = $<HTMLInputElement>('legExitDate')?.value || todayStr();
  const reason = ($<HTMLSelectElement>('legReason')?.value || 'despido_injustificado') as
    | 'despido_injustificado'
    | 'renuncia'
    | 'despido_justificado'
    | 'periodo_prueba'
    | 'otro';
  const customReason = ($<HTMLInputElement>('legCustomReason')?.value || '').trim().slice(0, 80);
  const reasonMap: Record<string, string> = {
    despido_injustificado: 'Despido Injustificado',
    renuncia: 'Renuncia Voluntaria',
    despido_justificado: 'Despido Justificado',
    periodo_prueba: 'Período de Prueba (< 6 meses)',
    otro: customReason || 'Otro motivo',
  };
  const reasonLabel = reasonMap[reason] || reason;

  const monthlySalary = Math.max(0, Number($<HTMLInputElement>('legSalary')?.value) || 0);
  const pendingDays = Math.max(0, Number($<HTMLInputElement>('legPendingDays')?.value) || 0);
  const unpaidVacationDays = Math.max(0, Number($<HTMLInputElement>('legUnpaidVac')?.value) || 0);
  const activeExtraConcepts = legalExtraConcepts
    .map((item, idx) => ({
      id: item.id,
      concept: item.concept.trim().slice(0, 80) || (idx === 0 ? 'Comisión / Viático / Bonificación' : `Concepto Adicional ${idx + 1}`),
      amount: Math.max(0, Math.round(Number(item.amount) || 0)),
    }))
    .filter((item) => item.amount > 0);
  const manualAmount = activeExtraConcepts.reduce((sum, item) => sum + item.amount, 0);
  const applyIps = Boolean($<HTMLInputElement>('legApplyIps')?.checked);

  const res = computeParaguayLegalLiquidation({
    hireDate,
    exitDate,
    monthlySalary,
    reason,
    pendingDays,
    unpaidVacationDays,
    manualBonusGs: manualAmount,
    applyIps,
  });

  return {
    emp,
    hireDate,
    exitDate,
    reason,
    customReason,
    reasonLabel,
    monthlySalary,
    pendingDays,
    unpaidVacationDays,
    activeExtraConcepts,
    manualAmount,
    applyIps,
    res,
  };
}

function recalcLegalLive(): void {
  const c = getCurrentLegalCalc();
  const { res } = c;
  const setTxt = (id: string, val: string) => {
    const el = $(id);
    if (el) el.textContent = val;
  };

  setTxt('legTenureBadge', `Antigüedad: ${res.years} año(s), ${res.months} mes(es), ${res.days} día(s)`);

  const ruleNoteEl = $('legRuleNote');
  if (ruleNoteEl) {
    ruleNoteEl.innerHTML = res.isUnderSixMonths
      ? `<div class="pill-warn">Antigüedad menor a 6 meses: según Código Laboral PY solo corresponde salario pendiente, aguinaldo proporcional y vacaciones.</div>`
      : c.reason !== 'despido_injustificado'
        ? `<div class="pill-blue">Motivo (${escapeHtml(c.reasonLabel)}): sin preaviso ni indemnización por antigüedad automática.</div>`
        : `<div class="pill-ok">Despido Injustificado: incluye Preaviso (${res.preavisoDays} días) + Indemnización por Antigüedad (${res.indemYearsCount} año(s) × 15 días = ${res.indemDays} días).</div>`;
  }

  setTxt('legRow1Det', `${c.pendingDays} días × ${fmtGs(res.dailyWage)} (Imponible IPS)`);
  setTxt('legRow1Amt', fmtGs(res.pendingSalaryGs));
  setTxt('legRow2Amt', fmtGs(res.aguinaldoGs));
  setTxt('legRow3Det', `Escala ${res.vacAnnualDays}d (${c.unpaidVacationDays} caus. + ${res.vacPropDays} prop.)`);
  setTxt('legRow3Amt', fmtGs(res.vacacionesGs));
  setTxt('legRow4Det', `${res.preavisoDays} días — Libre de IPS`);
  setTxt('legRow4Amt', fmtGs(res.preavisoGs));
  setTxt('legRow5Det', `${res.indemDays} días (15d/año o frac. >6m) — Libre de IPS`);
  setTxt('legRow5Amt', fmtGs(res.indemnizacionGs));
  setTxt('legRow7Det', `Solo sobre imponibles (${fmtGs(res.imponibleBaseGs)})`);
  setTxt('legRow7Amt', `- ${fmtGs(res.ipsDeductionGs)}`);
  setTxt('legNetTotal', fmtGs(res.netTotalGs));

  const wa = buildWhatsappUrls(buildLegalReceiptDoc().plainTextSummary);
  const waSup = $<HTMLAnchorElement>('legWaSupport');
  const waAny = $<HTMLAnchorElement>('legWaAny');
  if (waSup) waSup.href = wa.supportUrl;
  if (waAny) waAny.href = wa.anyContactUrl;
}

function buildLegalReceiptDoc(): ReceiptDocument {
  const c = getCurrentLegalCalc();
  const { res } = c;
  const empName = c.emp?.name || 'Funcionario';
  const empCi = c.emp?.ci || '—';
  const sector = c.emp?.sector || '—';

  const manualRowsHtml = c.activeExtraConcepts
    .map((item) => fmtGsRow(`Concepto Manual: ${item.concept}`, item.amount))
    .join('');
  const manualWaLines = c.activeExtraConcepts
    .map((item) => `\n• ${item.concept}: ${fmtGs(item.amount)}`)
    .join('');

  const bodyHtml = `
    <p style="font-size:12px;margin-bottom:8px">
      <strong>Funcionario:</strong> ${escapeHtml(empName)} | <strong>C.I.:</strong> ${escapeHtml(empCi)} | <strong>Sector:</strong> ${escapeHtml(sector)}<br/>
      <strong>Ingreso:</strong> ${escapeHtml(c.hireDate)} | <strong>Salida:</strong> ${escapeHtml(c.exitDate)} | <strong>Antigüedad:</strong> ${res.years}a ${res.months}m ${res.days}d<br/>
      <strong>Motivo:</strong> ${escapeHtml(c.reasonLabel)} | <strong>Salario Base:</strong> ${fmtGs(c.monthlySalary)}
    </p>
    <table>
      <thead><tr><th>Concepto (Código Laboral PY)</th><th style="text-align:right">Importe (Gs.)</th></tr></thead>
      <tbody>
        ${fmtGsRow(`Salario Pendiente (${c.pendingDays} días)`, res.pendingSalaryGs)}
        ${fmtGsRow('Aguinaldo Proporcional (1/12 — Libre de IPS)', res.aguinaldoGs)}
        ${fmtGsRow(`Vacaciones Causadas/Prop. (escala ${res.vacAnnualDays}d)`, res.vacacionesGs)}
        ${fmtGsRow(`Preaviso Art. 87 (${res.preavisoDays} días)`, res.preavisoGs)}
        ${fmtGsRow(`Indemnización Antigüedad Art. 91 (${res.indemDays} días)`, res.indemnizacionGs)}
        ${manualRowsHtml}
        ${fmtGsRow('Descuento IPS (9% solo sobre conceptos imponibles)', -res.ipsDeductionGs)}
        ${fmtGsRow('TOTAL NETO LIQUIDACIÓN FINAL', res.netTotalGs, true)}
      </tbody>
    </table>`;

  const plainTextSummary = `CARL PETERS — Liquidación Final Legal (PY)\nFuncionario: ${empName} (C.I. ${empCi})\nIngreso: ${c.hireDate} | Salida: ${c.exitDate} (${res.years}a ${res.months}m)\nMotivo: ${c.reasonLabel}\n• Salario Pendiente: ${fmtGs(res.pendingSalaryGs)}\n• Aguinaldo Prop.: ${fmtGs(res.aguinaldoGs)}\n• Vacaciones: ${fmtGs(res.vacacionesGs)}\n• Preaviso: ${fmtGs(res.preavisoGs)}\n• Indemnización: ${fmtGs(res.indemnizacionGs)}${manualWaLines}\n• IPS 9%: -${fmtGs(res.ipsDeductionGs)}\nTOTAL NETO: ${fmtGs(res.netTotalGs)}`;

  return {
    title: 'RECIBO OFICIAL DE LIQUIDACIÓN FINAL E INDEMNIZACIÓN',
    subtitle: `Código Laboral de la República del Paraguay — ${empName} (C.I. ${empCi})`,
    companyLogo: state.companyLogo,
    bodyHtml,
    plainTextSummary,
    showSignatures: true,
  };
}

async function saveLegalLiquidation(): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Solo el Administrador conectado con Google puede guardar liquidaciones', 'err');
    return;
  }
  const c = getCurrentLegalCalc();
  if (!c.emp) {
    showToast('Selecciona un funcionario', 'err');
    return;
  }
  const ok = await openModal({
    title: `Registrar Liquidación Legal — ${c.emp.name}`,
    body: `Motivo: ${c.reasonLabel}\n¿Confirmas registrar la liquidación final legal por ${fmtGs(c.res.netTotalGs)} en Firestore?`,
    confirmText: 'Guardar Liquidación',
    confirmClass: 'btn-ok',
  });
  if (!ok) return;

  const payrollId = generateDocId('leg');
  const manualPart = c.activeExtraConcepts.length
    ? `, ${c.activeExtraConcepts.map((item) => `${item.concept} ${fmtGs(item.amount)}`).join(', ')}`
    : '';
  try {
    await setDoc(doc(db, 'payrolls', payrollId), {
      type: 'legal',
      employeeId: c.emp.id,
      ownerUid: c.emp.ownerUid || currentUser.uid,
      empName: c.emp.name,
      empCi: c.emp.ci,
      sector: c.emp.sector,
      periodStart: c.hireDate,
      periodEnd: c.exitDate,
      daysCount: c.res.totalDaysService,
      normalSec: 0,
      extraSec: 0,
      hourlyRate: c.emp.hourlyRate ?? 15000,
      overtimePct: c.emp.overtimePct ?? 50,
      normalSubtotal: c.res.pendingSalaryGs + c.res.vacacionesGs,
      extraSubtotal: c.res.aguinaldoGs + c.res.preavisoGs + c.res.indemnizacionGs + c.res.manualBonusGs,
      previousBalance: 0,
      ipsDeduction: c.res.ipsDeductionGs,
      netTotal: c.res.netTotalGs,
      ipsApplied: c.applyIps,
      summary: `Liquidación Legal (${c.reasonLabel}): Salario ${fmtGs(c.res.pendingSalaryGs)}, Ag. ${fmtGs(c.res.aguinaldoGs)}, Vac. ${fmtGs(c.res.vacacionesGs)}, Preav. ${fmtGs(c.res.preavisoGs)}, Indem. ${fmtGs(c.res.indemnizacionGs)}${manualPart}.`.slice(0, SCHEMA_LIMITS.SUMMARY_MAX),
      createdAt: serverTimestamp(),
    });
    showToast('✓ Liquidación legal registrada en Firestore', 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `payrolls/${payrollId}`);
    showToast('Error al registrar liquidación legal', 'err');
  }
}

function printLegalReceipt(): void {
  triggerPrintReceipt(buildLegalReceiptDoc());
}

function downloadLegalPdf(): void {
  const c = getCurrentLegalCalc();
  const slug = (c.emp?.name || 'legal').replace(/[^a-zA-Z0-9]+/g, '_');
  downloadReceiptHtmlForPdf(`Liquidacion_Legal_${slug}_${todayStr()}.html`, buildLegalReceiptDoc());
  showToast('Liquidación legal lista para PDF', 'ok');
}

// === RRHH SUB 3: EXTRACTOS HISTÓRICOS POR EMPLEADO Y SECTOR ===
function setExtPreset(preset: 'day' | 'month' | 'year' | 'multi'): void {
  const t = todayStr();
  const y = Number(t.slice(0, 4));
  const m = t.slice(0, 7);
  const fromEl = $<HTMLInputElement>('extFrom');
  const toEl = $<HTMLInputElement>('extTo');
  if (!fromEl || !toEl) return;

  toEl.value = t;
  if (preset === 'day') fromEl.value = t;
  else if (preset === 'month') fromEl.value = `${m}-01`;
  else if (preset === 'year') fromEl.value = `${y}-01-01`;
  else fromEl.value = `${y - 2}-01-01`;
  renderExtractos();
}

function getExtractoData() {
  const fromEl = $<HTMLInputElement>('extFrom');
  const toEl = $<HTMLInputElement>('extTo');
  const secFilter = $<HTMLSelectElement>('extSector')?.value || 'ALL';
  const from = fromEl?.value || `${currentMonthStr()}-01`;
  const to = toEl?.value || todayStr();
  const today = todayStr();

  const pays = state.payrolls.filter(
    (p) => p.periodEnd >= from && p.periodEnd <= to && (secFilter === 'ALL' || p.sector === secFilter)
  );
  const exps = state.expenses.filter(
    (e) => e.date >= from && e.date <= to && (secFilter === 'ALL' || e.sector === secFilter)
  );

  const sectorMap = new Map<string, { salary: number; pending: number; expense: number }>();
  const empMap = new Map<
    string,
    { name: string; sector: string; count: number; normalSec: number; extraSec: number; total: number }
  >();

  let totalPay = 0;
  for (const p of pays) {
    totalPay += p.netTotal;
    const s = sectorMap.get(p.sector) || { salary: 0, pending: 0, expense: 0 };
    s.salary += p.netTotal;
    sectorMap.set(p.sector, s);

    const em = empMap.get(p.employeeId) || {
      name: p.empName,
      sector: p.sector,
      count: 0,
      normalSec: 0,
      extraSec: 0,
      total: 0,
    };
    em.count += 1;
    em.normalSec += p.normalSec || 0;
    em.extraSec += p.extraSec || 0;
    em.total += p.netTotal;
    empMap.set(p.employeeId, em);
  }

  // Include active unclosed marks in [from, to] (strictly after employee's lastClosedDate) so calendar edits sync in real time
  let totalPending = 0;
  let totalPendingNormSec = 0;
  let totalPendingExtSec = 0;
  for (const emp of state.employees) {
    const empSector = emp.sector || 'General';
    if (secFilter !== 'ALL' && empSector !== secFilter) continue;
    const lastClosed = emp.lastClosedDate || '';
    let openNormSec = 0;
    let openExtSec = 0;
    for (const mk of Object.values(state.marks)) {
      if (mk.employeeId !== emp.id) continue;
      if (mk.date < from || mk.date > to) continue;
      if (lastClosed && mk.date <= lastClosed) continue;
      const { normSec, extSec } = computeDayHours(mk, mk.date, state.rules, mk.date === today);
      openNormSec += normSec;
      openExtSec += extSec;
    }
    if (openNormSec > 0 || openExtSec > 0) {
      const rate = emp.hourlyRate ?? 15000;
      const otPct = emp.overtimePct ?? 50;
      const otRate = Math.round(rate * (1 + otPct / 100));
      const pendingAmt = Math.round((openNormSec / 3600) * rate) + Math.round((openExtSec / 3600) * otRate);

      totalPending += pendingAmt;
      totalPendingNormSec += openNormSec;
      totalPendingExtSec += openExtSec;

      const s = sectorMap.get(empSector) || { salary: 0, pending: 0, expense: 0 };
      s.pending += pendingAmt;
      sectorMap.set(empSector, s);

      const em = empMap.get(emp.id) || {
        name: emp.name,
        sector: empSector,
        count: 0,
        normalSec: 0,
        extraSec: 0,
        total: 0,
      };
      em.normalSec += openNormSec;
      em.extraSec += openExtSec;
      em.total += pendingAmt;
      empMap.set(emp.id, em);
    }
  }

  let totalExp = 0;
  for (const e of exps) {
    totalExp += e.amount;
    const s = sectorMap.get(e.sector) || { salary: 0, pending: 0, expense: 0 };
    s.expense += e.amount;
    sectorMap.set(e.sector, s);
  }

  return {
    from,
    to,
    secFilter,
    totalPay,
    totalPending,
    totalPendingNormSec,
    totalPendingExtSec,
    totalExp,
    totalAll: totalPay + totalPending + totalExp,
    sectorRows: Array.from(sectorMap.entries()).sort(
      (a, b) => b[1].salary + b[1].pending + b[1].expense - (a[1].salary + a[1].pending + a[1].expense)
    ),
    empRows: Array.from(empMap.values()).sort((a, b) => b.total - a.total),
  };
}

function renderExtractos(): void {
  const d = getExtractoData();
  const setTxt = (id: string, val: string) => {
    const el = $(id);
    if (el) el.textContent = val;
  };
  setTxt('extTotPay', fmtGs(d.totalPay));
  setTxt('extTotPending', fmtGs(d.totalPending));
  setTxt('extTotPendingHrs', `Norm: ${fmtHMS(d.totalPendingNormSec)} • Ext: ${fmtHMS(d.totalPendingExtSec)}`);
  setTxt('extTotExp', fmtGs(d.totalExp));
  setTxt('extTotAll', fmtGs(d.totalAll));

  const secBody = $('extSectorBody');
  if (secBody) {
    secBody.innerHTML = d.sectorRows.length
      ? d.sectorRows
          .map(
            ([sec, v]) => `<tr>
          <td><strong>${escapeHtml(sec)}</strong></td>
          <td>${fmtGs(v.salary)}</td>
          <td style="color:#0891b2;font-weight:700">${fmtGs(v.pending)}</td>
          <td>${fmtGs(v.expense)}</td>
          <td><strong>${fmtGs(v.salary + v.pending + v.expense)}</strong></td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="5" style="text-align:center;color:#64748b;padding:12px">Sin movimientos en este rango.</td></tr>`;
  }

  const empBody = $('extEmpBody');
  if (empBody) {
    empBody.innerHTML = d.empRows.length
      ? d.empRows
          .map(
            (e) => `<tr>
          <td><strong>${escapeHtml(e.name)}</strong></td>
          <td>${escapeHtml(e.sector)}</td>
          <td>${fmtHMS(e.normalSec)}</td>
          <td style="color:#2563eb;font-weight:700">${fmtHMS(e.extraSec)}</td>
          <td>${e.count}</td>
          <td><strong>${fmtGs(e.total)}</strong></td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="6" style="text-align:center;color:#64748b;padding:12px">Sin movimientos en este rango.</td></tr>`;
  }

  const wa = buildWhatsappUrls(buildExtractoReceiptDoc().plainTextSummary);
  const waSup = $<HTMLAnchorElement>('extWaSupport');
  const waAny = $<HTMLAnchorElement>('extWaAny');
  if (waSup) waSup.href = wa.supportUrl;
  if (waAny) waAny.href = wa.anyContactUrl;
}

function buildExtractoReceiptDoc(): ReceiptDocument {
  const d = getExtractoData();
  const secHtml = d.sectorRows
    .map(
      ([sec, v]) =>
        `<tr><td>${escapeHtml(sec)}</td><td style="text-align:right">${fmtGs(v.salary)}</td><td style="text-align:right">${fmtGs(v.pending)}</td><td style="text-align:right">${fmtGs(v.expense)}</td><td style="text-align:right"><strong>${fmtGs(v.salary + v.pending + v.expense)}</strong></td></tr>`
    )
    .join('');
  const empHtml = d.empRows
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.sector)}</td><td style="text-align:right">${fmtHMS(e.normalSec)}</td><td style="text-align:right">${fmtHMS(e.extraSec)}</td><td style="text-align:center">${e.count}</td><td style="text-align:right"><strong>${fmtGs(e.total)}</strong></td></tr>`
    )
    .join('');

  const bodyHtml = `
    <p style="font-size:12px;margin-bottom:8px"><strong>Rango:</strong> ${escapeHtml(d.from)} al ${escapeHtml(d.to)} | <strong>Sector:</strong> ${escapeHtml(d.secFilter === 'ALL' ? 'Todos' : d.secFilter)}</p>
    <table>
      <thead><tr><th>Resumen Empresa</th><th style="text-align:right">Importe (Gs.)</th></tr></thead>
      <tbody>
        ${fmtGsRow('Total Salarios Liquidados', d.totalPay)}
        ${fmtGsRow(`Pendiente en Curso (Norm: ${fmtHMS(d.totalPendingNormSec)} / Ext: ${fmtHMS(d.totalPendingExtSec)})`, d.totalPending)}
        ${fmtGsRow('Total Gastos Manuales Inmutables', d.totalExp)}
        ${fmtGsRow('TOTAL GENERAL EMPRESA', d.totalAll, true)}
      </tbody>
    </table>
    <h4 style="margin-top:14px;font-size:13px">Total Gastado por Sector</h4>
    <table><thead><tr><th>Sector</th><th style="text-align:right">Liquidado</th><th style="text-align:right">Pendiente</th><th style="text-align:right">Gastos</th><th style="text-align:right">Total</th></tr></thead><tbody>${secHtml || '<tr><td colspan="5">Sin datos</td></tr>'}</tbody></table>
    <h4 style="margin-top:14px;font-size:13px">Extracto por Empleado</h4>
    <table><thead><tr><th>Empleado</th><th>Sector</th><th style="text-align:right">H. Normales</th><th style="text-align:right">H. Extras</th><th style="text-align:center">Liq.</th><th style="text-align:right">Total (Gs.)</th></tr></thead><tbody>${empHtml || '<tr><td colspan="6">Sin datos</td></tr>'}</tbody></table>`;

  const plainTextSummary = `CARL PETERS — Extracto General (${d.from} al ${d.to})\n• Salarios Liquidados: ${fmtGs(d.totalPay)}\n• Pendiente en Curso: ${fmtGs(d.totalPending)} (Norm: ${fmtHMS(d.totalPendingNormSec)} / Ext: ${fmtHMS(d.totalPendingExtSec)})\n• Gastos Manuales: ${fmtGs(d.totalExp)}\nTOTAL GENERAL EMPRESA: ${fmtGs(d.totalAll)}`;
  return {
    title: 'EXTRACTO HISTÓRICO POR PERSONAL Y SECTOR',
    subtitle: `Período ${d.from} al ${d.to}`,
    companyLogo: state.companyLogo,
    bodyHtml,
    plainTextSummary,
    showSignatures: true,
  };
}

function printExtractoReceipt(): void {
  triggerPrintReceipt(buildExtractoReceiptDoc());
}

function downloadExtractoPdf(): void {
  downloadReceiptHtmlForPdf(`Extracto_Empresa_${todayStr()}.html`, buildExtractoReceiptDoc());
  showToast('Extracto descargado listo para guardar como PDF', 'ok');
}

// === RRHH SUB 4: GASTOS MANUALES INMUTABLES ===
async function saveImmutableExpense(): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Solo el Administrador conectado con Google puede cargar gastos', 'err');
    return;
  }
  const date = ($<HTMLInputElement>('expDate')?.value || todayStr()).trim();
  const sector = ($<HTMLSelectElement>('expSector')?.value || '').trim().slice(0, SCHEMA_LIMITS.SECTOR_MAX);
  const concept = ($<HTMLInputElement>('expConcept')?.value || '').trim().slice(0, SCHEMA_LIMITS.CONCEPT_MAX);
  const invoice = ($<HTMLInputElement>('expInvoice')?.value || '').trim().slice(0, SCHEMA_LIMITS.INVOICE_MAX);
  const amount = Math.round(Number($<HTMLInputElement>('expAmount')?.value) || 0);

  if (!SCHEMA_LIMITS.DATE_PATTERN.test(date) || !sector || !concept || amount <= 0) {
    showToast('Completa Fecha, Sector, Concepto y un Monto mayor a 0 Gs.', 'err');
    return;
  }

  const ok = await openModal({
    title: 'Confirmar Gasto Inmutable',
    body: `Fecha: ${date} | Sector: ${sector} | Factura: ${invoice || 'S/N'} | Monto: ${fmtGs(amount)}.\n\nUna vez guardado en Firestore, este gasto NO se podrá editar ni borrar.`,
    confirmText: '🔒 Guardar Definitivamente',
    confirmClass: 'btn-pri',
  });
  if (!ok) return;

  const expId = generateDocId('exp');
  try {
    await setDoc(doc(db, 'expenses', expId), {
      date,
      sector,
      concept,
      invoice,
      amount,
      createdByUid: currentUser.uid,
      createdAt: serverTimestamp(),
    });
    const clear = ['expConcept', 'expInvoice', 'expAmount'];
    clear.forEach((id) => {
      const el = $<HTMLInputElement>(id);
      if (el) el.value = '';
    });
    showToast(`🔒 Gasto inmutable de ${fmtGs(amount)} guardado`, 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `expenses/${expId}`);
    showToast('Error al guardar el gasto en Firestore', 'err');
  }
}

function getFilteredExpenses() {
  const mode = $<HTMLSelectElement>('expFilterMode')?.value || 'month';
  const dayEl = $<HTMLInputElement>('expFilterDay');
  const monthEl = $<HTMLInputElement>('expFilterMonth');
  const yearEl = $<HTMLInputElement>('expFilterYear');
  const fromEl = $<HTMLInputElement>('expFilterFrom');
  const toEl = $<HTMLInputElement>('expFilterTo');
  const sec = $<HTMLSelectElement>('expFilterSector')?.value || 'ALL';

  dayEl?.classList.toggle('hidden', mode !== 'day');
  monthEl?.classList.toggle('hidden', mode !== 'month');
  yearEl?.classList.toggle('hidden', mode !== 'year');
  fromEl?.classList.toggle('hidden', mode !== 'range');
  toEl?.classList.toggle('hidden', mode !== 'range');

  const refDay = dayEl?.value || todayStr();
  const refMonth = monthEl?.value || currentMonthStr();
  const refYear = yearEl?.value || currentYearStr();
  const refFrom = fromEl?.value || `${currentMonthStr()}-01`;
  const refTo = toEl?.value || todayStr();

  const bySec = state.expenses.filter((e) => sec === 'ALL' || e.sector === sec);

  const filtered = bySec.filter((e) => {
    if (mode === 'day') return e.date === refDay;
    if (mode === 'month') return e.date.startsWith(refMonth);
    if (mode === 'year') return e.date.startsWith(refYear);
    return e.date >= refFrom && e.date <= refTo;
  });

  // Always compute automatic Day / Month / Year totals (respecting sector filter!)
  const activeDay = mode === 'day' ? refDay : todayStr();
  const activeMonth = mode === 'month' ? refMonth : activeDay.slice(0, 7);
  const activeYear = mode === 'year' ? refYear : activeMonth.slice(0, 4);

  let totDay = 0;
  let totMonth = 0;
  let totYear = 0;
  for (const e of bySec) {
    if (e.date === activeDay) totDay += e.amount;
    if (e.date.startsWith(activeMonth)) totMonth += e.amount;
    if (e.date.startsWith(activeYear)) totYear += e.amount;
  }

  return { mode, sec, filtered, totDay, totMonth, totYear, activeDay, activeMonth, activeYear };
}

function renderExpenses(): void {
  const d = getFilteredExpenses();
  const body = $('expBody');
  if (body) {
    body.innerHTML = d.filtered.length
      ? d.filtered
          .map(
            (e) => `<tr>
          <td>${escapeHtml(e.date)}</td>
          <td><strong>${escapeHtml(e.sector)}</strong></td>
          <td>${escapeHtml(e.concept)}</td>
          <td><code>${escapeHtml(e.invoice || 'S/N')}</code></td>
          <td><strong>${fmtGs(e.amount)}</strong></td>
          <td><span class="pill-lock">🔒 Inmutable</span></td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="6" style="text-align:center;color:#64748b;padding:14px">Sin gastos registrados en este filtro.</td></tr>`;
  }

  const setTxt = (id: string, val: string) => {
    const el = $(id);
    if (el) el.textContent = val;
  };
  setTxt('expTotDay', fmtGs(d.totDay));
  setTxt('expTotMonth', fmtGs(d.totMonth));
  setTxt('expTotYear', fmtGs(d.totYear));

  const wa = buildWhatsappUrls(buildExpensesReceiptDoc().plainTextSummary);
  const waSup = $<HTMLAnchorElement>('expWaSupport');
  const waAny = $<HTMLAnchorElement>('expWaAny');
  if (waSup) waSup.href = wa.supportUrl;
  if (waAny) waAny.href = wa.anyContactUrl;
}

function buildExpensesReceiptDoc(): ReceiptDocument {
  const d = getFilteredExpenses();
  const rowsHtml = d.filtered
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.date)}</td><td>${escapeHtml(e.sector)}</td><td>${escapeHtml(e.concept)}</td><td>${escapeHtml(e.invoice || 'S/N')}</td><td style="text-align:right"><strong>${fmtGs(e.amount)}</strong></td></tr>`
    )
    .join('');

  const bodyHtml = `
    <p style="font-size:12px;margin-bottom:8px"><strong>Sector:</strong> ${escapeHtml(d.sec === 'ALL' ? 'Todos' : d.sec)} | <strong>Registros inmutables:</strong> ${d.filtered.length}</p>
    <table>
      <thead><tr><th>Fecha</th><th>Sector</th><th>Concepto</th><th>Factura</th><th style="text-align:right">Monto (Gs.)</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="5">Sin gastos en este período</td></tr>'}</tbody>
    </table>
    <table style="margin-top:12px">
      <tbody>
        ${fmtGsRow(`Total del Día (${d.activeDay})`, d.totDay)}
        ${fmtGsRow(`Total del Mes (${d.activeMonth})`, d.totMonth)}
        ${fmtGsRow(`Total del Año (${d.activeYear})`, d.totYear, true)}
      </tbody>
    </table>`;

  const plainTextSummary = `CARL PETERS — Reporte de Gastos Inmutables (${d.sec === 'ALL' ? 'Todos los sectores' : d.sec})\n• Total Día (${d.activeDay}): ${fmtGs(d.totDay)}\n• Total Mes (${d.activeMonth}): ${fmtGs(d.totMonth)}\n• Total Año (${d.activeYear}): ${fmtGs(d.totYear)}`;
  return {
    title: 'REPORTE OFICIAL DE GASTOS MANUALES INMUTABLES',
    subtitle: `Sector: ${d.sec === 'ALL' ? 'Todos' : d.sec} • Día ${d.activeDay} / Mes ${d.activeMonth} / Año ${d.activeYear}`,
    companyLogo: state.companyLogo,
    bodyHtml,
    plainTextSummary,
    showSignatures: true,
  };
}

function printExpensesReceipt(): void {
  triggerPrintReceipt(buildExpensesReceiptDoc());
}

function downloadExpensesPdf(): void {
  downloadReceiptHtmlForPdf(`Gastos_Inmutables_${todayStr()}.html`, buildExpensesReceiptDoc());
  showToast('Reporte de gastos descargado listo para PDF', 'ok');
}

// === Admin Tab 4: Calendario & PDF (Edición Inline HH:MM:SS + Agregar Hora + Sync Global) ===
function normalizeTimeInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let candidate = trimmed;
  if (/^\d{2}:\d{2}$/.test(candidate)) {
    candidate = `${candidate}:00`;
  }
  if (!/^\d{2}:\d{2}:\d{2}$/.test(candidate)) return null;
  const [h, m, s] = candidate.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function refreshPulledSalaryHoursSilently(): void {
  const payEmpId = $<HTMLSelectElement>('payEmp')?.value || '';
  if (!payEmpId) return;
  const emp = state.employees.find((e) => e.id === payEmpId);
  if (!emp) return;

  const lastClosed = emp.lastClosedDate || '';
  const today = todayStr();
  const openMarks = Object.values(state.marks)
    .filter((m) => m.employeeId === emp.id && (!lastClosed || m.date > lastClosed) && m.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  let normalSec = 0;
  let extraSec = 0;
  let daysCount = 0;

  for (const mk of openMarks) {
    const { workedSec, normSec, extSec } = computeDayHours(mk, mk.date, state.rules, mk.date === today);
    if (workedSec > 0) {
      daysCount++;
      normalSec += normSec;
      extraSec += extSec;
    }
  }

  const periodStart = openMarks.length
    ? openMarks[0].date
    : lastClosed
      ? shiftDateStr(lastClosed, 1)
      : today;

  // Keep synced with latest marks whenever Pago de Salario is tracking this employee (unless explicitly cleared)
  if (pulledSalary.employeeId === emp.id || pulledSalary.employeeId !== '') {
    pulledSalary = {
      employeeId: emp.id,
      periodStart,
      periodEnd: today,
      daysCount,
      normalSec,
      extraSec,
      previousBalance: Number(emp.carryOverBalance || 0),
    };
    const rangeInfo = $('payRangeInfo');
    const periodBadge = $('payPeriodBadge');
    if (rangeInfo) {
      rangeInfo.textContent = lastClosed
        ? `Desde último cierre (${lastClosed}) → ${periodStart} al ${today} • ${daysCount} día(s) con marcaciones`
        : `Sin cierres previos → ${periodStart} al ${today} • ${daysCount} día(s) con marcaciones`;
    }
    if (periodBadge) {
      periodBadge.textContent = daysCount > 0 ? `Planilla Activa (${daysCount} días)` : 'Al día / 0h pendientes';
      periodBadge.className = daysCount > 0 ? 'pill-warn' : 'pill-ok';
    }
  }
}

function syncGlobalMarksDependents(): void {
  refreshPulledSalaryHoursSilently();
  renderHoy();
  recalcSalaryLive();
  recalcLegalLive();
  renderExtractos();
  renderCal();
  renderRanking();
  renderMobShell();
}

async function saveCalendarMarkSlot(empId: string, dateStr: string, slot: MarkSlot, rawTime: string): Promise<boolean> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Conecta tu cuenta Google Administrador para editar o agregar horas en Firestore', 'err');
    return false;
  }
  const emp = state.employees.find((e) => e.id === empId);
  if (!emp) {
    showToast('Funcionario no encontrado', 'err');
    return false;
  }
  if (!SCHEMA_LIMITS.DATE_PATTERN.test(dateStr)) {
    showToast('Fecha inválida (usa formato AAAA-MM-DD)', 'err');
    return false;
  }
  const normalized = normalizeTimeInput(rawTime);
  if (normalized === null) {
    showToast('Hora inválida. Usa formato HH:MM:SS (ej. 07:30:00)', 'err');
    return false;
  }

  const markId = makeMarkDocId(emp.id, dateStr);
  const existingMark = state.marks[markId];
  const markRef = doc(db, 'marks', markId);

  try {
    if (!existingMark) {
      const nextDoc: AttendanceMarkDoc = {
        id: markId,
        employeeId: emp.id,
        ownerUid: emp.ownerUid || currentUser.uid,
        date: dateStr,
        e1: slot === 'e1' ? normalized : '',
        s2: slot === 's2' ? normalized : '',
        e3: slot === 'e3' ? normalized : '',
        s4: slot === 's4' ? normalized : '',
        lat: 0,
        lng: 0,
        hasGps: false,
      };
      await setDoc(markRef, {
        employeeId: nextDoc.employeeId,
        ownerUid: nextDoc.ownerUid,
        date: nextDoc.date,
        e1: nextDoc.e1,
        s2: nextDoc.s2,
        e3: nextDoc.e3,
        s4: nextDoc.s4,
        lat: 0,
        lng: 0,
        hasGps: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      state.marks[markId] = nextDoc;
    } else {
      await updateDoc(markRef, {
        [slot]: normalized,
        updatedAt: serverTimestamp(),
      });
      state.marks[markId] = { ...existingMark, [slot]: normalized };
    }

    saveLocalCache();
    activeCalEdit = null;
    syncGlobalMarksDependents();
    const slotNames: Record<MarkSlot, string> = {
      e1: 'Ent. 1',
      s2: 'Sal. 2',
      e3: 'Ent. 3',
      s4: 'Sal. 4',
    };
    showToast(
      normalized
        ? `✓ ${slotNames[slot]} (${dateStr}) guardada: ${normalized} — todo recalculado`
        : `✓ ${slotNames[slot]} (${dateStr}) borrada — todo recalculado`,
      'ok'
    );
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `marks/${markId}`);
    showToast('No se pudo guardar la hora en Firestore', 'err');
    return false;
  }
}

function startInlineCalEdit(empId: string, dateStr: string, slot: MarkSlot): void {
  if (!currentUser || !isCloudAdmin) {
    showToast('Conecta tu cuenta Google Administrador para editar horas', 'err');
    return;
  }
  activeCalEdit = { empId, date: dateStr, slot };
  renderCal();
  window.setTimeout(() => {
    const inp = $<HTMLInputElement>('calInlineTimeInput');
    if (inp) inp.focus();
  }, 20);
}

function cancelInlineCalEdit(): void {
  activeCalEdit = null;
  renderCal();
}

async function commitInlineCalEdit(clearValue = false): Promise<void> {
  if (!activeCalEdit) return;
  const { empId, date, slot } = activeCalEdit;
  const raw = clearValue ? '' : $<HTMLInputElement>('calInlineTimeInput')?.value || '';
  await saveCalendarMarkSlot(empId, date, slot, raw);
}

function openAddHourModal(): void {
  if (!currentUser || !isCloudAdmin) {
    showToast('Conecta tu cuenta Google Administrador para agregar horas', 'err');
    return;
  }
  const modal = $('addHourModal');
  if (!modal) return;
  const empSel = $<HTMLSelectElement>('addHrEmp');
  const calEmpVal = $<HTMLSelectElement>('calEmp')?.value || '';
  if (empSel && calEmpVal && state.employees.some((e) => e.id === calEmpVal)) {
    empSel.value = calEmpVal;
  }
  const dateEl = $<HTMLInputElement>('addHrDate');
  if (dateEl) {
    const calMonth = $<HTMLInputElement>('calMonth')?.value || currentMonthStr();
    const t = todayStr();
    dateEl.value = t.startsWith(calMonth) ? t : `${calMonth}-01`;
  }
  const timeEl = $<HTMLInputElement>('addHrTime');
  if (timeEl) timeEl.value = nowTimeStr();
  modal.classList.remove('hidden');
}

function closeAddHourModal(): void {
  $('addHourModal')?.classList.add('hidden');
}

async function saveAddHourModal(event: Event): Promise<void> {
  event.preventDefault();
  const empId = $<HTMLSelectElement>('addHrEmp')?.value || '';
  const dateStr = $<HTMLInputElement>('addHrDate')?.value || '';
  const slot = ($<HTMLSelectElement>('addHrSlot')?.value || 'e1') as MarkSlot;
  const rawTime = $<HTMLInputElement>('addHrTime')?.value || '';

  const ok = await saveCalendarMarkSlot(empId, dateStr, slot, rawTime);
  if (ok) {
    closeAddHourModal();
    // Point calendar selectors to the updated employee/month and expand detail table so user sees it immediately
    const calEmp = $<HTMLSelectElement>('calEmp');
    const calMonth = $<HTMLInputElement>('calMonth');
    const calPer = $<HTMLSelectElement>('calPer');
    if (calEmp && empId) calEmp.value = empId;
    if (calMonth && dateStr.length >= 7) calMonth.value = dateStr.slice(0, 7);
    if (calPer) {
      const dayNum = Number(dateStr.slice(8, 10)) || 1;
      if (calPer.value === '1' && dayNum > 15) calPer.value = '2';
      else if (calPer.value === '2' && dayNum <= 15) calPer.value = '1';
    }
    const wrap = $('calTableWrap');
    const btn = $('calToggleBtn');
    if (wrap && wrap.classList.contains('hidden')) {
      wrap.classList.remove('hidden');
      if (btn) btn.textContent = 'Ocultar detalle de fechas ▲';
    }
    renderCal();
  }
}

function toggleCalDetail(): void {
  const wrap = $('calTableWrap');
  const btn = $('calToggleBtn');
  if (!wrap || !btn) return;
  const hiddenNow = wrap.classList.toggle('hidden');
  btn.textContent = hiddenNow ? 'Ver detalle de fechas ▼' : 'Ocultar detalle de fechas ▲';
}

function renderCal(): void {
  const empId = $<HTMLSelectElement>('calEmp')?.value || '';
  const monthEl = $<HTMLInputElement>('calMonth');
  const per = $<HTMLSelectElement>('calPer')?.value || '1';
  const sumEl = $('calSummary');
  const titleEl = $('calPlanillaTitle');
  const badgeEl = $('calStatusBadge');
  const body = $('calBody');
  if (!body) return;

  if (monthEl && !monthEl.value) monthEl.value = currentMonthStr();
  const month = monthEl?.value || currentMonthStr();
  const emp = state.employees.find((e) => e.id === empId);

  if (!emp) {
    if (sumEl) sumEl.textContent = 'Selecciona un empleado para ver el reporte.';
    body.innerHTML = '';
    return;
  }

  const dates = getMonthDates(month, per);
  const lastClosed = emp.lastClosedDate || '';
  let totNorm = 0;
  let totExt = 0;
  let daysWorked = 0;
  let closedDays = 0;
  let openDays = 0;

  const renderSlotCell = (dateStr: string, slot: MarkSlot, currentVal?: string): string => {
    const isEditing =
      activeCalEdit &&
      activeCalEdit.empId === emp.id &&
      activeCalEdit.date === dateStr &&
      activeCalEdit.slot === slot;

    if (isEditing) {
      const safeVal = currentVal && /^\d{2}:\d{2}:\d{2}$/.test(currentVal) ? currentVal : '';
      return `<td>
        <span class="cal-inline-edit">
          <input id="calInlineTimeInput" type="time" step="1" value="${escapeHtml(safeVal)}" class="cal-time-in"/>
          <button type="button" class="cal-mini-btn btn-ok" data-cal-save="1" title="Guardar">✓</button>
          <button type="button" class="cal-mini-btn btn-warn" data-cal-clear="1" title="Borrar hora">🗑</button>
          <button type="button" class="cal-mini-btn btn-out" data-cal-cancel="1" title="Cancelar">✕</button>
        </span>
      </td>`;
    }

    const displayVal = currentVal || '—';
    return `<td>
      <span class="cal-cell">
        <span>${escapeHtml(displayVal)}</span>
        <button type="button" class="cal-edit-ico no-print" data-cal-edit="${escapeHtml(dateStr)}|${slot}" title="Editar ${slot.toUpperCase()} (HH:MM:SS)">✎</button>
      </span>
    </td>`;
  };

  const rows = dates.map((d) => {
    const mk = state.marks[makeMarkDocId(emp.id, d)];
    const { workedSec, normSec, extSec } = computeDayHours(mk, d, state.rules, d === todayStr());
    const isClosed = Boolean(lastClosed && d <= lastClosed);
    if (isClosed) closedDays++;
    else openDays++;
    if (workedSec > 0) daysWorked++;
    totNorm += normSec;
    totExt += extSec;

    const statusHtml = isClosed
      ? `<span class="pill-blue">✅ Liquidado</span>`
      : `<span class="pill-ok">🟢 Activa</span>`;
    const rowBg = workedSec > 0 ? '' : ' style="color:#94a3b8"';
    return `<tr${rowBg}>
      <td>${escapeHtml(d)}</td>
      <td>${statusHtml}</td>
      ${renderSlotCell(d, 'e1', mk?.e1)}
      ${renderSlotCell(d, 's2', mk?.s2)}
      ${renderSlotCell(d, 'e3', mk?.e3)}
      ${renderSlotCell(d, 's4', mk?.s4)}
      <td>${fmtHMS(normSec)}</td>
      <td style="color:#2563eb;font-weight:700">${fmtHMS(extSec)}</td>
      <td><strong>${fmtHMS(workedSec)}</strong></td>
    </tr>`;
  });

  const periodLabel = per === '1' ? '1ra Quincena (1–15)' : per === '2' ? '2da Quincena (16–Fin)' : 'Mes Completo';
  if (titleEl) titleEl.textContent = `${emp.name} — ${month} • ${periodLabel}`;

  if (badgeEl) {
    if (closedDays === dates.length) {
      badgeEl.className = 'pill-blue';
      badgeEl.textContent = `✅ CERRADA / LIQUIDADA (hasta ${lastClosed})`;
    } else if (closedDays > 0 && openDays > 0) {
      badgeEl.className = 'pill-warn';
      badgeEl.textContent = `🟡 PARCIAL (Cerrada hasta ${lastClosed} • Nueva Planilla Activa)`;
    } else {
      badgeEl.className = 'pill-ok';
      badgeEl.textContent = '🟢 PLANILLA ACTIVA ACTUAL';
    }
  }

  if (sumEl) {
    sumEl.innerHTML = `C.I. ${escapeHtml(emp.ci)} • ${escapeHtml(emp.sector)} | Días trabajados: <strong>${daysWorked}</strong> | Normales: <strong>${fmtHMS(totNorm)}</strong> | Extras: <strong style="color:#2563eb">${fmtHMS(totExt)}</strong> | Total: <strong style="color:#16a34a">${fmtHMS(totNorm + totExt)}</strong>`;
  }
  body.innerHTML = rows.join('');

  body.querySelectorAll<HTMLButtonElement>('[data-cal-edit]').forEach((btn) => {
    btn.onclick = () => {
      const [dateStr, slot] = (btn.dataset.calEdit || '').split('|');
      if (dateStr && (slot === 'e1' || slot === 's2' || slot === 'e3' || slot === 's4')) {
        startInlineCalEdit(emp.id, dateStr, slot);
      }
    };
  });

  const inlineInput = $<HTMLInputElement>('calInlineTimeInput');
  if (inlineInput) {
    inlineInput.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void commitInlineCalEdit(false);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelInlineCalEdit();
      }
    };
  }
  const saveBtn = body.querySelector<HTMLButtonElement>('[data-cal-save]');
  if (saveBtn) saveBtn.onclick = () => void commitInlineCalEdit(false);
  const clearBtn = body.querySelector<HTMLButtonElement>('[data-cal-clear]');
  if (clearBtn) clearBtn.onclick = () => void commitInlineCalEdit(true);
  const cancelBtn = body.querySelector<HTMLButtonElement>('[data-cal-cancel]');
  if (cancelBtn) cancelBtn.onclick = () => cancelInlineCalEdit();
}

// === Admin Tab 5: GPS Map (maxZoom 22 / maxNativeZoom 17 + Tooltips Permanentes + Auto-centrado) ===
function initGpsMapIfNeeded(): void {
  if (map) return;
  const container = $('gpsMap');
  if (!container) return;

  map = L.map(container, { zoomControl: true, maxZoom: 22 }).setView([-25.2637, -57.5759], 12);

  const esriSat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Esri Satellite', maxZoom: 22, maxNativeZoom: 17 }
  );
  const esriLabels = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 22, maxNativeZoom: 17 }
  );
  satGrp = L.layerGroup([esriSat, esriLabels]);

  osmLay = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 22,
    maxNativeZoom: 19,
  });

  satGrp.addTo(map);
  mkLay = L.layerGroup().addTo(map);
}

function setMapLayer(layer: MapLayerMode): void {
  initGpsMapIfNeeded();
  if (!map || !satGrp || !osmLay) return;
  if (layer === 'sat') {
    if (map.hasLayer(osmLay)) map.removeLayer(osmLay);
    if (!map.hasLayer(satGrp)) satGrp.addTo(map);
  } else {
    if (map.hasLayer(satGrp)) map.removeLayer(satGrp);
    if (!map.hasLayer(osmLay)) osmLay.addTo(map);
  }
}

function setGpsMode(mode: GpsMode): void {
  gpsMode = mode;
  const mLive = $('mLive');
  const mHist = $('mHist');
  if (mLive) mLive.className = mode === 'live' ? 'btn btn-pri' : 'btn btn-dark';
  if (mHist) mHist.className = mode === 'hist' ? 'btn btn-pri' : 'btn btn-dark';
  void refreshGps(true);
}

async function refreshGps(autoCenter: boolean): Promise<void> {
  initGpsMapIfNeeded();
  if (!map || !mkLay) return;

  mkLay.clearLayers();
  if (poly) {
    map.removeLayer(poly);
    poly = null;
  }

  const selEmp = $<HTMLSelectElement>('gpsEmp')?.value || 'ALL';
  const dateEl = $<HTMLInputElement>('gpsDate');
  if (dateEl && !dateEl.value) dateEl.value = todayStr();
  const selDate = dateEl?.value || todayStr();
  const bounds: L.LatLngExpression[] = [];

  if (gpsMode === 'live') {
    const entries = Object.values(state.gpsLive).filter((g) => selEmp === 'ALL' || g.employeeId === selEmp);

    for (const g of entries) {
      const marker = L.circleMarker([g.lat, g.lng], {
        radius: 9,
        color: '#ffffff',
        weight: 2,
        fillColor: '#2563eb',
        fillOpacity: 0.95,
      });
      marker.bindTooltip(`${escapeHtml(g.empName)} • ${escapeHtml(g.sector)} • ${escapeHtml(g.time)}`, {
        permanent: true,
        direction: 'top',
        offset: [0, -10],
        className: 'cp-gps-tip',
      });
      marker.bindPopup(
        `<strong>${escapeHtml(g.empName)}</strong><br/>Sector: ${escapeHtml(g.sector)}<br/>Fecha: ${escapeHtml(g.date)} ${escapeHtml(g.time)}<br/>Precisión: ±${Math.round(g.accuracy)}m`
      );
      marker.addTo(mkLay);
      bounds.push([g.lat, g.lng]);
    }
  } else {
    if (!currentUser) return;
    const targets = selEmp === 'ALL' ? state.employees : state.employees.filter((e) => e.id === selEmp);

    for (const emp of targets) {
      const histId = makeMarkDocId(emp.id, selDate);
      try {
        const snap = await getDoc(doc(db, 'gpsHistory', histId));
        if (!snap.exists()) continue;
        const data = snap.data() as Omit<GpsHistoryDoc, 'id'>;
        const pts = Array.isArray(data.points) ? data.points : [];
        if (!pts.length) continue;

        const latlngs: L.LatLngExpression[] = pts.map((p) => [p.lat, p.lng]);
        poly = L.polyline(latlngs, { color: '#38bdf8', weight: 4 }).addTo(map);
        latlngs.forEach((ll) => bounds.push(ll));

        const first = pts[0];
        const last = pts[pts.length - 1];
        L.circleMarker([first.lat, first.lng], {
          radius: 7,
          color: '#fff',
          weight: 2,
          fillColor: '#16a34a',
          fillOpacity: 0.95,
        })
          .bindTooltip(`Inicio • ${escapeHtml(emp.name)} • ${escapeHtml(first.t)}`, {
            permanent: true,
            direction: 'bottom',
            offset: [0, 8],
            className: 'cp-gps-tip',
          })
          .bindPopup(`<strong>Inicio • ${escapeHtml(emp.name)}</strong><br/>${escapeHtml(first.t)}`)
          .addTo(mkLay);

        L.circleMarker([last.lat, last.lng], {
          radius: 8,
          color: '#fff',
          weight: 2,
          fillColor: '#dc2626',
          fillOpacity: 0.95,
        })
          .bindTooltip(`${escapeHtml(emp.name)} • ${escapeHtml(emp.sector)} • ${escapeHtml(last.t)}`, {
            permanent: true,
            direction: 'top',
            offset: [0, -10],
            className: 'cp-gps-tip',
          })
          .bindPopup(`<strong>Último • ${escapeHtml(emp.name)}</strong><br/>${escapeHtml(last.t)} (${pts.length} pts)`)
          .addTo(mkLay);
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `gpsHistory/${histId}`);
      }
    }
  }

  if (bounds.length && (autoCenter || !centeredOnce)) {
    if (bounds.length === 1) {
      map.setView(bounds[0], 17, { animate: true });
    } else {
      map.fitBounds(L.latLngBounds(bounds), { padding: [44, 44], maxZoom: 18 });
    }
    centeredOnce = true;
  }
}

function centerGps(): void {
  centeredOnce = false;
  void refreshGps(true);
}

// === Admin Tab 6: Config & Logo ===
async function uploadLogo(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  if (!currentUser || !isCloudAdmin) {
    showToast('Inicia sesión con Google Admin para actualizar el logo en Firestore', 'err');
    input.value = '';
    return;
  }

  try {
    showToast('Procesando y subiendo logo a Firestore...', 'info');
    const dataUrl = await compressImageToDataUrl(file);
    state.companyLogo = dataUrl;
    applyBrandingAndRules();
    saveLocalCache();

    await setDoc(doc(db, 'settings', 'company'), {
      companyLogo: dataUrl,
      wd: state.rules.wd,
      sat: state.rules.sat,
      sectors: getAllSectors().slice(0, SCHEMA_LIMITS.SECTORS_MAX),
      updatedAt: serverTimestamp(),
    });
    showToast('✓ Logo actualizado en vivo en Firestore', 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'settings/company');
    showToast(`No se pudo subir el logo: ${error instanceof Error ? error.message : 'error'}`, 'err');
  } finally {
    input.value = '';
  }
}

async function clearLogo(): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Solo Admin conectado con Google puede cambiar el logo', 'err');
    return;
  }
  try {
    await setDoc(doc(db, 'settings', 'company'), {
      companyLogo: '',
      wd: state.rules.wd,
      sat: state.rules.sat,
      sectors: getAllSectors().slice(0, SCHEMA_LIMITS.SECTORS_MAX),
      updatedAt: serverTimestamp(),
    });
    showToast('Logo restaurado al predeterminado', 'info');
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'settings/company');
    showToast('Error al quitar el logo', 'err');
  }
}

async function saveRules(): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Conecta Google Admin para guardar reglas en Firestore', 'err');
    return;
  }
  const wd = Math.min(24, Math.max(1, Number($<HTMLInputElement>('cfgWd')?.value) || 8));
  const sat = Math.min(24, Math.max(0, Number($<HTMLInputElement>('cfgSat')?.value) || 4));
  try {
    await setDoc(doc(db, 'settings', 'company'), {
      companyLogo: state.companyLogo || '',
      wd,
      sat,
      sectors: getAllSectors().slice(0, SCHEMA_LIMITS.SECTORS_MAX),
      updatedAt: serverTimestamp(),
    });
    showToast(`Reglas guardadas (Lun–Vie ${wd}h, Sáb ${sat}h)`, 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'settings/company');
    showToast('Error al guardar reglas', 'err');
  }
}

async function wipeAllData(): Promise<void> {
  if (!currentUser || !isCloudAdmin) {
    showToast('Solo el Administrador conectado con Google puede reiniciar la base', 'err');
    return;
  }
  const confirmed = await openModal({
    title: 'Reiniciar Base de Datos',
    body: 'Esto eliminará empleados, marcaciones, liquidaciones y registros GPS (los gastos inmutables permanecen protegidos). Escribe BORRAR para confirmar.',
    inputLabel: 'Confirmación',
    inputPlaceholder: 'BORRAR',
    confirmText: 'Reiniciar Base',
    confirmClass: 'btn-err',
  });
  if (confirmed !== 'BORRAR') {
    if (confirmed !== null) showToast('Confirmación cancelada', 'info');
    return;
  }

  const colNames = ['marks', 'gpsLive', 'gpsHistory', 'payrolls', 'employees'];
  try {
    for (const cName of colNames) {
      const snap = await getDocs(collection(db, cName));
      await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, cName, d.id))));
    }
    sessionStorage.removeItem(MOB_KEY);
    localStorage.removeItem(MOB_KEY);
    localStorage.removeItem(MOB_REMEMBERED_KEY);
    localStorage.removeItem(CACHE_KEY);
    stopGpsLoop();
    showToast('Base de datos reiniciada (gastos inmutables intactos)', 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, 'wipeAllData');
    showToast('Error al limpiar la base de datos', 'err');
  }
}

// === Admin Tab 6: Ranking & Gráficas ===
function setRankingMode(mode: RankingMode): void {
  rankMode = mode;
  const empChk = $<HTMLInputElement>('rankModeEmp');
  const secChk = $<HTMLInputElement>('rankModeSec');
  if (empChk) empChk.checked = mode === 'emp';
  if (secChk) secChk.checked = mode === 'sector';
  $('rankModeEmpLbl')?.classList.toggle('active', mode === 'emp');
  $('rankModeSecLbl')?.classList.toggle('active', mode === 'sector');
  renderRanking();
}

function setRankingDateFilter(filter: RankingDateFilter): void {
  rankDateFilter = filter;
  const setBtn = (id: string, active: boolean) => {
    const b = $(id);
    if (b) b.className = active ? 'btn btn-pri btn-sm' : 'btn btn-out btn-sm';
  };
  setBtn('rankFiltRangeBtn', filter === 'range');
  setBtn('rankFiltMonthBtn', filter === 'month');
  setBtn('rankFiltYearBtn', filter === 'year');

  $('rankFromWrap')?.classList.toggle('hidden', filter !== 'range');
  $('rankToWrap')?.classList.toggle('hidden', filter !== 'range');
  $('rankMonthWrap')?.classList.toggle('hidden', filter !== 'month');
  $('rankYearWrap')?.classList.toggle('hidden', filter !== 'year');
  renderRanking();
}

function toggleAllRankingSelection(): void {
  const universe = buildRankingUniverse(
    state,
    DEFAULT_SECTORS,
    rankMode,
    resolveRankingDateRange(
      rankDateFilter,
      $<HTMLInputElement>('rankFrom')?.value || '',
      $<HTMLInputElement>('rankTo')?.value || '',
      $<HTMLInputElement>('rankMonth')?.value || '',
      $<HTMLInputElement>('rankYear')?.value || ''
    ).from,
    resolveRankingDateRange(
      rankDateFilter,
      $<HTMLInputElement>('rankFrom')?.value || '',
      $<HTMLInputElement>('rankTo')?.value || '',
      $<HTMLInputElement>('rankMonth')?.value || '',
      $<HTMLInputElement>('rankYear')?.value || ''
    ).to,
    $<HTMLInputElement>('rankIncludeOpen')?.checked ?? true
  );
  const selSet = rankSelectedByMode[rankMode];
  const allChecked = universe.length > 0 && universe.every((it) => selSet.has(it.key));
  if (allChecked) {
    selSet.clear();
  } else {
    universe.forEach((it) => selSet.add(it.key));
  }
  renderRanking();
}

function renderRanking(): void {
  const pickList = $('rankPickList');
  const chartHost = $('rankChartHost');
  const tableBody = $('rankTableBody');
  if (!pickList || !chartHost || !tableBody) return;

  const range = resolveRankingDateRange(
    rankDateFilter,
    $<HTMLInputElement>('rankFrom')?.value || '',
    $<HTMLInputElement>('rankTo')?.value || '',
    $<HTMLInputElement>('rankMonth')?.value || '',
    $<HTMLInputElement>('rankYear')?.value || ''
  );
  const includeOpen = $<HTMLInputElement>('rankIncludeOpen')?.checked ?? true;
  const universe = buildRankingUniverse(state, DEFAULT_SECTORS, rankMode, range.from, range.to, includeOpen);

  const selSet = rankSelectedByMode[rankMode];
  const knownSet = rankKnownByMode[rankMode];

  // Auto-select any newly discovered employees/sectors on first load
  for (const it of universe) {
    if (!knownSet.has(it.key)) {
      knownSet.add(it.key);
      selSet.add(it.key);
    }
  }
  // Prune stale keys no longer in universe
  const validKeys = new Set(universe.map((it) => it.key));
  for (const k of Array.from(selSet)) {
    if (!validKeys.has(k)) selSet.delete(k);
  }

  // Render left panel checkboxes
  pickList.innerHTML = universe.length
    ? universe
        .map((it) => {
          const checked = selSet.has(it.key);
          const display =
            rankMode === 'emp'
              ? `${escapeHtml(it.label)} <span style="color:#64748b;font-weight:500">(${escapeHtml(it.subLabel)})</span>`
              : `${escapeHtml(it.label)}`;
          return `<label class="rank-pick-item">
            <input type="checkbox" data-rank-key="${escapeHtml(it.key)}" ${checked ? 'checked' : ''}/>
            <span class="rank-dot" style="background:${it.color};margin-right:2px"></span>
            <span style="min-width:0;flex:1">${display}</span>
          </label>`;
        })
        .join('')
    : `<div style="color:#64748b;font-size:12px;text-align:center;padding:16px">No hay ${rankMode === 'emp' ? 'empleados' : 'sectores'} registrados aún.</div>`;

  pickList.querySelectorAll<HTMLInputElement>('input[data-rank-key]').forEach((chk) => {
    chk.onchange = () => {
      const k = chk.dataset.rankKey || '';
      if (!k) return;
      if (chk.checked) selSet.add(k);
      else selSet.delete(k);
      renderRanking();
    };
  });

  const selectedItems = universe.filter((it) => selSet.has(it.key));
  const sorted = sortRankingItems(selectedItems);
  lastRankingSorted = sorted;
  lastRankingPeriodLabel = range.periodLabel;

  const selCountEl = $('rankSelCount');
  if (selCountEl) selCountEl.textContent = `${selectedItems.length} / ${universe.length}`;

  const toggleBtn = $('rankToggleAllBtn');
  if (toggleBtn) {
    const allChecked = universe.length > 0 && selectedItems.length === universe.length;
    toggleBtn.textContent = allChecked ? 'Desmarcar Todos' : 'Marcar Todos';
  }

  const periodEl = $('rankPeriodSummary');
  if (periodEl) {
    periodEl.textContent = `Período: ${range.periodLabel} • Modo: ${rankMode === 'emp' ? 'Por Empleado' : 'Por Sector'}`;
  }

  const nameHead = $('rankNameColHead');
  if (nameHead) nameHead.textContent = rankMode === 'emp' ? 'Empleado (Sector)' : 'Sector';

  const chartMeta = $('rankChartMeta');
  if (chartMeta) {
    const totalGs = sorted.reduce((acc, it) => acc + it.total, 0);
    chartMeta.textContent = `${sorted.length} seleccionados • Total: ${fmtGs(totalGs)}`;
  }

  const tableBadge = $('rankTableBadge');
  if (tableBadge) {
    tableBadge.textContent = sorted.length ? `#1: ${sorted[0].label}` : 'Sin selección';
  }

  chartHost.innerHTML = renderBarChartHtml(sorted);
  tableBody.innerHTML = renderRankingTableRows(sorted, rankMode);

  const recDoc = buildRankingReceiptDoc(sorted, rankMode, range.periodLabel, state.companyLogo);
  const wa = buildWhatsappUrls(recDoc.plainTextSummary);
  const waSup = $<HTMLAnchorElement>('rankWaSupport');
  const waAny = $<HTMLAnchorElement>('rankWaAny');
  if (waSup) waSup.href = wa.supportUrl;
  if (waAny) waAny.href = wa.anyContactUrl;
}

function printRankingReceipt(): void {
  const docObj = buildRankingReceiptDoc(lastRankingSorted, rankMode, lastRankingPeriodLabel || todayStr(), state.companyLogo);
  triggerPrintReceipt(docObj);
}

function downloadRankingPdf(): void {
  const docObj = buildRankingReceiptDoc(lastRankingSorted, rankMode, lastRankingPeriodLabel || todayStr(), state.companyLogo);
  downloadReceiptHtmlForPdf(`CARL-PETERS-Ranking-${rankMode}-${todayStr()}.html`, docObj);
  showToast('Reporte Ranking listo (ábrelo para guardar en PDF)', 'ok');
}

// === Mobile Auth, Remembered User (Quick PIN), Cloud Memory & C.I. PIN Recovery ===
function loadRememberedMobUser(): RememberedMobUser | null {
  try {
    const raw = localStorage.getItem(MOB_REMEMBERED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedMobUser>;
    if (parsed && typeof parsed.name === 'string' && parsed.name && typeof parsed.ci === 'string') {
      return {
        employeeId: typeof parsed.employeeId === 'string' ? parsed.employeeId : '',
        name: parsed.name,
        ci: parsed.ci,
        sector: typeof parsed.sector === 'string' ? parsed.sector : 'General',
      };
    }
  } catch {
    // ignore corrupt storage
  }
  return null;
}

function saveRememberedMobUser(user: RememberedMobUser): void {
  try {
    localStorage.setItem(MOB_REMEMBERED_KEY, JSON.stringify(user));
  } catch {
    // ignore
  }
}

function clearRememberedMobUser(): void {
  localStorage.removeItem(MOB_REMEMBERED_KEY);
  sessionStorage.removeItem(MOB_KEY);
  localStorage.removeItem(MOB_KEY);
  const lId = $<HTMLInputElement>('lId');
  const lPin = $<HTMLInputElement>('lPin');
  if (lId) lId.value = '';
  if (lPin) lPin.value = '';
  setAuthTab('login');
  renderRememberedMobAuthUI();
  showToast('Ingresa con otro usuario o regístrate', 'info');
}

function renderRememberedMobAuthUI(): void {
  let remembered = loadRememberedMobUser();
  // Keep remembered name/sector synced with Firestore if present
  if (remembered) {
    const liveEmp =
      state.employees.find((e) => e.id === remembered!.employeeId) ||
      state.employees.find((e) => normalizeCi(e.ci) === normalizeCi(remembered!.ci));
    if (liveEmp) {
      if (
        liveEmp.id !== remembered.employeeId ||
        liveEmp.name !== remembered.name ||
        liveEmp.ci !== remembered.ci ||
        liveEmp.sector !== remembered.sector
      ) {
        remembered = {
          employeeId: liveEmp.id,
          name: liveEmp.name,
          ci: liveEmp.ci,
          sector: liveEmp.sector,
        };
        saveRememberedMobUser(remembered);
      }
    }
  }

  const box = $('mobRememberedBox');
  const tabs = $('mobAuthTabs');
  const idWrap = $('lIdWrap');
  const idInput = $<HTMLInputElement>('lId');
  const switchBtn = $('mobSwitchUserBtn');
  const nameEl = $('mobRemName');
  const metaEl = $('mobRemMeta');
  const avEl = $('mobRemAvatar');

  if (remembered) {
    if (box) box.classList.remove('hidden');
    if (tabs) tabs.classList.add('hidden');
    if (idWrap) idWrap.classList.add('hidden');
    if (idInput) {
      idInput.required = false;
      idInput.value = remembered.ci || remembered.name;
    }
    if (switchBtn) switchBtn.classList.remove('hidden');
    if (nameEl) nameEl.textContent = remembered.name;
    if (metaEl) metaEl.textContent = `C.I. ${remembered.ci} • ${remembered.sector}`;
    if (avEl) {
      const initials = remembered.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join('');
      avEl.textContent = initials || 'CP';
    }
    // Always show login form in Quick-PIN mode
    $('fLogin')?.classList.remove('hidden');
    $('fReg')?.classList.add('hidden');
  } else {
    if (box) box.classList.add('hidden');
    if (tabs) tabs.classList.remove('hidden');
    if (idWrap) idWrap.classList.remove('hidden');
    if (idInput) idInput.required = true;
    if (switchBtn) switchBtn.classList.add('hidden');
  }
}

function setAuthTab(tab: AuthTab): void {
  $('tLog')?.classList.toggle('active', tab === 'login');
  $('tReg')?.classList.toggle('active', tab === 'reg');
  $('fLogin')?.classList.toggle('hidden', tab !== 'login');
  $('fReg')?.classList.toggle('hidden', tab !== 'reg');
}

function getActiveMobEmployee(): EmployeeDoc | null {
  const id = sessionStorage.getItem(MOB_KEY);
  if (!id) return null;
  return state.employees.find((e) => e.id === id) || null;
}

async function mobLogin(event: Event): Promise<void> {
  event.preventDefault();
  if (!currentUser || !currentUser.emailVerified) {
    showToast('Primero conecta tu cuenta Google', 'err');
    return;
  }

  const remembered = loadRememberedMobUser();
  const rawId = remembered ? remembered.ci || remembered.name : ($<HTMLInputElement>('lId')?.value || '').trim();
  const pin = ($<HTMLInputElement>('lPin')?.value || '').trim();
  const needle = rawId.toLowerCase();
  const needleCi = normalizeCi(rawId);

  const emp =
    (remembered?.employeeId ? state.employees.find((e) => e.id === remembered.employeeId) : undefined) ||
    state.employees.find(
      (e) =>
        e.name.toLowerCase() === needle ||
        (needleCi && normalizeCi(e.ci) === needleCi) ||
        (needle && e.name.toLowerCase().includes(needle))
    );

  if (!emp) {
    showToast('Funcionario no encontrado. Si cambiaste de celular, usa "¿Olvidaste tu PIN o cambiaste de celular?".', 'err');
    return;
  }

  const isMaster = pin === MASTER_PIN && isCloudAdmin;
  if (emp.pin !== pin && !isMaster) {
    showToast('PIN incorrecto', 'err');
    return;
  }

  if (!isCloudAdmin && emp.ownerUid !== currentUser.uid && emp.email === currentUser.email) {
    try {
      await updateDoc(doc(db, 'employees', emp.id), {
        ownerUid: currentUser.uid,
        pinResetEnabled: false,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `employees/${emp.id}`);
    }
  }

  saveRememberedMobUser({
    employeeId: emp.id,
    name: emp.name,
    ci: emp.ci,
    sector: emp.sector,
  });
  sessionStorage.setItem(MOB_KEY, emp.id);
  const pinInput = $<HTMLInputElement>('lPin');
  if (pinInput) pinInput.value = '';
  renderMobShell();
  startGpsLoop();
  showToast(`Bienvenido, ${emp.name}`, 'ok');
}

function setMobRegIps(hasIps: boolean): void {
  mobRegHasIps = hasIps;
  const btnCon = $('rBtnConIps');
  const btnSin = $('rBtnSinIps');
  if (btnCon) btnCon.className = hasIps ? 'ips-touch-btn active-con' : 'ips-touch-btn';
  if (btnSin) btnSin.className = hasIps ? 'ips-touch-btn' : 'ips-touch-btn active-sin';
}

async function mobRegister(event: Event): Promise<void> {
  event.preventDefault();
  if (!currentUser || !currentUser.emailVerified) {
    showToast('Primero conecta tu cuenta Google', 'err');
    return;
  }
  const name = ($<HTMLInputElement>('rName')?.value || '').trim().slice(0, SCHEMA_LIMITS.NAME_MAX);
  const ci = ($<HTMLInputElement>('rCi')?.value || '').trim().slice(0, SCHEMA_LIMITS.CI_MAX);
  const sector = (($<HTMLInputElement>('rSec')?.value || '').trim() || 'Ganado').slice(0, SCHEMA_LIMITS.SECTOR_MAX);
  const pin = ($<HTMLInputElement>('rPin')?.value || '').trim();

  if (!name || !ci || !SCHEMA_LIMITS.PIN_PATTERN.test(pin)) {
    showToast('Completa Nombre, C.I. y un PIN de 4 dígitos', 'err');
    return;
  }
  if (state.employees.some((e) => normalizeCi(e.ci) === normalizeCi(ci))) {
    showToast('Ya existe un registro con esa C.I. Usa "Ingresar" o recupera tu PIN.', 'err');
    setAuthTab('login');
    return;
  }

  const empId = generateEmployeeId(ci);
  const hasIps = mobRegHasIps;
  const ipsAmount = hasIps ? DEFAULT_IPS_GS : 0;
  try {
    await setDoc(doc(db, 'employees', empId), {
      name,
      ci,
      ciNormalized: normalizeCi(ci),
      sector,
      pin,
      hireDate: todayStr(),
      hourlyRate: 15000,
      overtimePct: 50,
      hasIps,
      ipsAmount,
      lastClosedDate: '',
      carryOverBalance: 0,
      pinResetEnabled: false,
      ownerUid: currentUser.uid,
      email: currentUser.email || '',
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    saveRememberedMobUser({
      employeeId: empId,
      name,
      ci,
      sector,
    });
    sessionStorage.setItem(MOB_KEY, empId);
    ($<HTMLFormElement>('fReg'))?.reset();
    setMobRegIps(false);
    const rSec = $<HTMLInputElement>('rSec');
    if (rSec) rSec.value = 'Ganado';
    renderMobShell();
    startGpsLoop();
    showToast(`Cuenta creada para ${name} (${hasIps ? 'CON IPS' : 'SIN IPS'})`, 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `employees/${empId}`);
    showToast('No se pudo crear la cuenta en Firestore', 'err');
  }
}

async function mobResetPin(): Promise<void> {
  if (!currentUser || !currentUser.emailVerified) {
    showToast('Conecta tu cuenta Google primero para recuperar tu ficha en la nube', 'err');
    return;
  }

  const prefillCi = ($<HTMLInputElement>('lId')?.value || '').trim();
  const res = await openModal({
    title: 'Recuperar Ficha e Historial por C.I.',
    body: 'Ingresa tu número de C.I. y crea un PIN nuevo de 4 dígitos. Si cambiaste de celular, solicita antes al Admin presionar "Resetear PIN" en tu ficha.',
    inputLabel: 'Número de C.I.',
    inputPlaceholder: 'Ej. 4.123.456',
    defaultValue: prefillCi,
    inputMaxLength: SCHEMA_LIMITS.CI_MAX,
    input2Label: 'Nuevo PIN (4 dígitos)',
    input2Type: 'password',
    input2Placeholder: '1234',
    input2MaxLength: 4,
    confirmText: 'Recuperar Cuenta y Entrar',
    confirmClass: 'btn-pri',
  });

  if (!Array.isArray(res)) return;
  const [ciInput, newPin] = res;
  const targetNorm = normalizeCi(ciInput);

  if (!targetNorm) {
    showToast('Ingresa tu número de C.I.', 'err');
    return;
  }
  if (!SCHEMA_LIMITS.PIN_PATTERN.test(newPin)) {
    showToast('El nuevo PIN debe tener exactamente 4 dígitos numéricos', 'err');
    return;
  }

  // 1. Search local accessible state first
  let targetEmp: EmployeeDoc | null =
    state.employees.find((e) => normalizeCi(e.ci) === targetNorm) || null;

  // 2. If not in local state (e.g. lost phone / new Google account), query unlocked recovery records in Firestore
  if (!targetEmp) {
    try {
      const snap = await getDocs(
        query(collection(db, 'employees'), where('pinResetEnabled', '==', true))
      );
      const match = snap.docs.find((d) => {
        const data = d.data() as Omit<EmployeeDoc, 'id'>;
        return normalizeCi(data.ci || '') === targetNorm || data.ciNormalized === targetNorm;
      });
      if (match) {
        targetEmp = { id: match.id, ...(match.data() as Omit<EmployeeDoc, 'id'>) };
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, 'employees(pinResetEnabled)');
    }
  }

  if (!targetEmp) {
    showToast('No se encontró una ficha con esa C.I. habilitada para recuperación. Pide al Admin presionar "Resetear PIN".', 'err');
    return;
  }

  try {
    const isRecoveryClaim = !isCloudAdmin && targetEmp.ownerUid !== currentUser.uid;
    const patch: Record<string, unknown> = isRecoveryClaim
      ? {
          ownerUid: currentUser.uid,
          email: currentUser.email || '',
          pin: newPin,
          pinResetEnabled: false,
          updatedAt: serverTimestamp(),
        }
      : {
          pin: newPin,
          pinResetEnabled: false,
          updatedAt: serverTimestamp(),
        };

    await updateDoc(doc(db, 'employees', targetEmp.id), patch);
    saveRememberedMobUser({
      employeeId: targetEmp.id,
      name: targetEmp.name,
      ci: targetEmp.ci,
      sector: targetEmp.sector,
    });
    sessionStorage.setItem(MOB_KEY, targetEmp.id);
    if (!state.employees.some((e) => e.id === targetEmp!.id)) {
      state.employees.push({ ...targetEmp, pin: newPin, ownerUid: currentUser.uid, pinResetEnabled: false });
    }
    renderMobShell();
    startGpsLoop();
    showToast(`✓ Ficha de ${targetEmp.name} recuperada con nuevo PIN`, 'ok');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `employees/${targetEmp.id}`);
    showToast('No se pudo actualizar el PIN. Pide al Admin habilitar "Resetear PIN".', 'err');
  }
}

function mobLogout(): void {
  sessionStorage.removeItem(MOB_KEY);
  stopGpsLoop();
  renderMobShell();
  showToast('Sesión bloqueada — ingresa tu PIN para volver a entrar', 'info');
}

function setMobSub(sub: MobSubTab): void {
  $('subPunchBtn')?.classList.toggle('active', sub === 'punch');
  $('subHoursBtn')?.classList.toggle('active', sub === 'hours');
  $('subPunch')?.classList.toggle('hidden', sub !== 'punch');
  $('subHours')?.classList.toggle('hidden', sub !== 'hours');
  if (sub === 'hours') renderMobHours();
}

function shiftMobDate(delta: number): void {
  const mDate = $<HTMLInputElement>('mDate');
  if (!mDate) return;
  mDate.value = shiftDateStr(mDate.value || todayStr(), delta);
  renderMob();
}

function renderMobShell(): void {
  const mobAuth = $('mobAuth');
  const mobApp = $('mobApp');
  const emp = getActiveMobEmployee();

  renderRememberedMobAuthUI();

  if (mobAuth && mobApp) {
    const showApp = Boolean(emp && currentUser && currentUser.emailVerified);
    mobAuth.classList.toggle('hidden', showApp);
    mobApp.classList.toggle('hidden', !showApp);
  }

  if (emp) {
    const meta = $('mMeta');
    if (meta) meta.textContent = `${emp.name} • C.I. ${emp.ci} • ${emp.sector}`;
    const mDate = $<HTMLInputElement>('mDate');
    if (mDate && !mDate.value) mDate.value = todayStr();
    const hMonth = $<HTMLInputElement>('hMonth');
    if (hMonth && !hMonth.value) hMonth.value = currentMonthStr();
    renderMob();
    renderMobHours();
  }
}

function getNextPunchSlot(mk?: AttendanceMarkDoc): { key: 'e1' | 's2' | 'e3' | 's4'; label: string } | null {
  if (!mk || !mk.e1) return { key: 'e1', label: 'Entrada 1 (Mañana)' };
  if (!mk.s2) return { key: 's2', label: 'Salida 2 (Almuerzo)' };
  if (!mk.e3) return { key: 'e3', label: 'Entrada 3 (Tarde)' };
  if (!mk.s4) return { key: 's4', label: 'Salida 4 (Final)' };
  return null;
}

function renderMob(): void {
  const emp = getActiveMobEmployee();
  if (!emp) return;
  const dateStr = $<HTMLInputElement>('mDate')?.value || todayStr();
  const mk = state.marks[makeMarkDocId(emp.id, dateStr)];
  const { normSec, extSec } = computeDayHours(mk, dateStr, state.rules, dateStr === todayStr());

  const mNorm = $('mNorm');
  const mExt = $('mExt');
  const mMarks = $('mMarks');
  const fpLbl = $('fpLbl');

  if (mNorm) mNorm.textContent = fmtHMS(normSec);
  if (mExt) mExt.textContent = fmtHMS(extSec);

  if (mMarks) {
    const slotRow = (title: string, val?: string) =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #f1f5f9">
        <span style="color:#475569;font-weight:600">${title}</span>
        <strong style="color:${val ? '#0f172a' : '#94a3b8'}">${escapeHtml(val || '—')}</strong>
      </div>`;
    mMarks.innerHTML =
      slotRow('1. Entrada Mañana (Ent. 1)', mk?.e1) +
      slotRow('2. Salida Almuerzo (Sal. 2)', mk?.s2) +
      slotRow('3. Entrada Tarde (Ent. 3)', mk?.e3) +
      slotRow('4. Salida Final (Sal. 4)', mk?.s4);
  }

  if (fpLbl) {
    const next = getNextPunchSlot(mk);
    fpLbl.textContent = next
      ? `Mantén la huella para marcar: ${next.label}`
      : 'Jornada completa (4/4 marcas registradas)';
  }
}

function renderMobHours(): void {
  const emp = getActiveMobEmployee();
  if (!emp) return;
  const range = $<HTMLSelectElement>('hRange')?.value || 'WEEK';
  const monthEl = $<HTMLInputElement>('hMonth');
  if (monthEl && !monthEl.value) monthEl.value = currentMonthStr();
  const month = monthEl?.value || currentMonthStr();

  const dates = range === 'WEEK' ? getCurrentWeekDates() : getMonthDates(month, range);
  let sumNorm = 0;
  let sumExt = 0;
  const items: string[] = [];

  for (const d of dates) {
    const mk = state.marks[makeMarkDocId(emp.id, d)];
    const { workedSec, normSec, extSec } = computeDayHours(mk, d, state.rules, d === todayStr());
    sumNorm += normSec;
    sumExt += extSec;
    if (mk && (mk.e1 || mk.s2 || mk.e3 || mk.s4)) {
      const closedTag = emp.lastClosedDate && d <= emp.lastClosedDate ? ' • ✅ Liquidado' : '';
      items.push(`<div class="card" style="margin:0;padding:8px;font-size:11px">
        <div style="display:flex;justify-content:space-between;font-weight:700;margin-bottom:3px">
          <span>${escapeHtml(d)}${closedTag}</span>
          <span style="color:#16a34a">${fmtHMS(workedSec)}</span>
        </div>
        <div style="color:#475569">E1: ${escapeHtml(mk.e1 || '—')} | S2: ${escapeHtml(mk.s2 || '—')} | E3: ${escapeHtml(mk.e3 || '—')} | S4: ${escapeHtml(mk.s4 || '—')}</div>
        <div style="color:#2563eb;margin-top:2px">Norm: ${fmtHMS(normSec)} • Ext: ${fmtHMS(extSec)}</div>
      </div>`);
    }
  }

  const setTxt = (id: string, val: string) => {
    const el = $(id);
    if (el) el.textContent = val;
  };
  setTxt('hNorm', fmtHMS(sumNorm));
  setTxt('hExt', fmtHMS(sumExt));
  setTxt('hTot', fmtHMS(sumNorm + sumExt));
  const hList = $('hList');
  if (hList) {
    hList.innerHTML = items.length
      ? items.reverse().join('')
      : `<div style="text-align:center;color:#64748b;padding:16px;font-size:12px">Sin marcaciones en este período.</div>`;
  }
}

// === Biometric Fingerprint Punch ===
function fpDown(): void {
  const btn = $('fpBtn');
  if (btn) btn.classList.add('scan');
  fpHolding = true;
  if (fpHoldTimer) window.clearTimeout(fpHoldTimer);
  fpHoldTimer = window.setTimeout(() => {
    if (fpHolding) {
      fpHolding = false;
      if (btn) btn.classList.remove('scan');
      void recordPunch();
    }
  }, 420);
}

function fpUp(): void {
  const btn = $('fpBtn');
  if (btn) btn.classList.remove('scan');
  if (fpHolding) {
    fpHolding = false;
    if (fpHoldTimer) window.clearTimeout(fpHoldTimer);
    void recordPunch();
  }
}

function fpCancel(): void {
  fpHolding = false;
  if (fpHoldTimer) window.clearTimeout(fpHoldTimer);
  $('fpBtn')?.classList.remove('scan');
}

async function recordPunch(): Promise<void> {
  if (!currentUser || !currentUser.emailVerified) {
    showToast('Conecta Google para registrar marcaciones en vivo', 'err');
    return;
  }
  const emp = getActiveMobEmployee();
  if (!emp) return;

  const dateStr = $<HTMLInputElement>('mDate')?.value || todayStr();
  if (!SCHEMA_LIMITS.DATE_PATTERN.test(dateStr)) {
    showToast('Fecha inválida', 'err');
    return;
  }

  const markId = makeMarkDocId(emp.id, dateStr);
  const existingMark = state.marks[markId];
  const next = getNextPunchSlot(existingMark);
  if (!next) {
    showToast('Las 4 marcaciones del día ya están completas', 'info');
    return;
  }

  const stamp = nowTimeStr();
  const markRef = doc(db, 'marks', markId);

  try {
    if (!existingMark) {
      await setDoc(markRef, {
        employeeId: emp.id,
        ownerUid: emp.ownerUid || currentUser.uid,
        date: dateStr,
        e1: next.key === 'e1' ? stamp : '',
        s2: next.key === 's2' ? stamp : '',
        e3: next.key === 'e3' ? stamp : '',
        s4: next.key === 's4' ? stamp : '',
        lat: lastCoords ? lastCoords.lat : 0,
        lng: lastCoords ? lastCoords.lng : 0,
        hasGps: Boolean(lastCoords),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(markRef, {
        [next.key]: stamp,
        lat: lastCoords ? lastCoords.lat : existingMark.lat || 0,
        lng: lastCoords ? lastCoords.lng : existingMark.lng || 0,
        hasGps: Boolean(lastCoords || existingMark.hasGps),
        updatedAt: serverTimestamp(),
      });
    }

    if (navigator.vibrate) {
      try {
        navigator.vibrate(80);
      } catch {
        // ignore
      }
    }
    showToast(`✓ ${next.label} marcada a las ${stamp}`, 'ok');
    void captureAndPushGps(true);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `marks/${markId}`);
    showToast('No se pudo guardar la marcación en Firestore', 'err');
  }
}

// === Live GPS Tracking ===
function updateGpsStatusText(text: string): void {
  const el = $('fpMsg');
  if (el) el.textContent = text;
}

function getBrowserPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS no soportado en este navegador'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 9000,
      maximumAge: 5000,
    });
  });
}

async function captureAndPushGps(forceHistory = false): Promise<void> {
  if (!currentUser || !currentUser.emailVerified) return;
  const emp = getActiveMobEmployee();
  if (!emp) return;

  try {
    const pos = await getBrowserPosition();
    const lat = Number(pos.coords.latitude.toFixed(6));
    const lng = Number(pos.coords.longitude.toFixed(6));
    const accuracy = Math.min(100000, Math.max(0, Math.round(pos.coords.accuracy || 0)));
    lastCoords = { lat, lng, accuracy };

    const dateStr = todayStr();
    const timeStr = nowTimeStr();
    updateGpsStatusText(`GPS EN VIVO • ±${accuracy}m • ${timeStr}`);

    await setDoc(doc(db, 'gpsLive', emp.id), {
      employeeId: emp.id,
      ownerUid: emp.ownerUid || currentUser.uid,
      empName: emp.name.slice(0, SCHEMA_LIMITS.NAME_MAX),
      sector: emp.sector.slice(0, SCHEMA_LIMITS.SECTOR_MAX),
      lat,
      lng,
      accuracy,
      date: dateStr,
      time: timeStr,
      updatedAt: serverTimestamp(),
    });

    const histId = makeMarkDocId(emp.id, dateStr);
    const histRef = doc(db, 'gpsHistory', histId);
    const histSnap = await getDoc(histRef);
    const existingPts =
      histSnap.exists() && Array.isArray(histSnap.data().points)
        ? (histSnap.data().points as { lat: number; lng: number; t: string }[])
        : [];

    const lastPt = existingPts[existingPts.length - 1];
    const movedEnough =
      !lastPt ||
      Math.abs(lastPt.lat - lat) > 0.00012 ||
      Math.abs(lastPt.lng - lng) > 0.00012;

    if (forceHistory || movedEnough) {
      const nextPts = [...existingPts, { lat, lng, t: timeStr }].slice(-SCHEMA_LIMITS.GPS_POINTS_MAX);
      await setDoc(histRef, {
        employeeId: emp.id,
        ownerUid: emp.ownerUid || currentUser.uid,
        date: dateStr,
        points: nextPts,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Permiso de ubicación pendiente';
    updateGpsStatusText(`GPS inactivo (${msg})`);
  }
}

function startGpsLoop(): void {
  stopGpsLoop();
  void captureAndPushGps(true);
  gpsTimer = window.setInterval(() => {
    void captureAndPushGps(false);
  }, 10000);
}

function stopGpsLoop(): void {
  if (gpsTimer !== null) {
    window.clearInterval(gpsTimer);
    gpsTimer = null;
  }
}

async function enableGpsOnce(): Promise<void> {
  try {
    const pos = await getBrowserPosition();
    const lat = pos.coords.latitude.toFixed(5);
    const lng = pos.coords.longitude.toFixed(5);
    const acc = Math.round(pos.coords.accuracy || 0);
    lastCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: acc };
    showToast(`GPS activo: ${lat}, ${lng} (±${acc}m)`, 'ok');
    if (getActiveMobEmployee()) await captureAndPushGps(true);
  } catch (err) {
    showToast(`No se pudo obtener GPS: ${err instanceof Error ? err.message : 'permiso denegado'}`, 'err');
  }
}

// === Global Render & Clock ===
function renderAll(): void {
  applyBrandingAndRules();
  renderSectorDropdowns();
  renderHoy();
  renderEmployees();
  renderPayrollHistory();
  recalcSalaryLive();
  recalcLegalLive();
  renderExtractos();
  renderExpenses();
  renderCal();
  renderRanking();
  renderMobShell();
}

function startClock(): void {
  if (clockTimer !== null) window.clearInterval(clockTimer);
  const tick = () => {
    const t = nowTimeStr();
    const mClock = $('mClock');
    if (mClock) mClock.textContent = `${todayStr()} • ${t}`;
    if (getActiveMobEmployee()) renderMob();
    if (localStorage.getItem(ADM_KEY) === '1') renderHoy();
  };
  tick();
  clockTimer = window.setInterval(tick, 1000);
}

// === Expose handlers for inline HTML attributes ===
Object.assign(window, {
  setLayout,
  loginAdmin,
  logoutAdmin,
  openAdminCover,
  openTab,
  openRrhhSub,
  toggleRegEmpBox,
  onNewEmpIpsToggle,
  onEdEmpIpsToggle,
  saveNewEmployee,
  closeEmpEdit,
  applyEmpEdit,
  resetEmpPin,
  deleteEmp,
  onPayEmpChange,
  onPayApplyIpsToggle,
  onPayIpsManualInput,
  clearSalaryForm,
  pullHoursSinceLastClose,
  recalcSalaryLive,
  liquidateAndClosePeriod,
  printSalaryReceipt,
  downloadSalaryPdf,
  onLegEmpChange,
  onLegReasonChange,
  addLegalConceptRow,
  removeLegalConceptRow,
  clearLegalForm,
  recalcLegalLive,
  saveLegalLiquidation,
  printLegalReceipt,
  downloadLegalPdf,
  setExtPreset,
  renderExtractos,
  printExtractoReceipt,
  downloadExtractoPdf,
  addCustomSector,
  saveImmutableExpense,
  renderExpenses,
  printExpensesReceipt,
  downloadExpensesPdf,
  toggleCalDetail,
  renderCal,
  openAddHourModal,
  closeAddHourModal,
  saveAddHourModal,
  setGpsMode,
  refreshGps,
  setMapLayer,
  centerGps,
  setRankingMode,
  setRankingDateFilter,
  toggleAllRankingSelection,
  renderRanking,
  printRankingReceipt,
  downloadRankingPdf,
  uploadLogo,
  clearLogo,
  openMobileLogoPicker,
  saveRules,
  enableGpsOnce,
  wipeAllData,
  unlockAdminPin,
  setAuthTab,
  setMobRegIps,
  mobLogin,
  mobResetPin,
  mobRegister,
  mobLogout,
  clearRememberedMobUser,
  setMobSub,
  shiftMobDate,
  renderMob,
  fpDown,
  fpUp,
  fpCancel,
  renderMobHours,
  handleGoogleAuthToggle,
  triggerGoogleSignIn,
  openPwaShareModal,
  closePwaShareModal,
  setPwaShareTarget,
  copyPwaLink,
  sharePwaNative,
  triggerPwaInstall,
  handleMobileInstallAction,
  downloadInstallPackage,
  downloadPwaManifest,
});

// === Bootstrap ===
async function bootstrap(): Promise<void> {
  // Migrate any legacy persistent mobile session ID to remembered quick-PIN user
  const legacyMobId = localStorage.getItem(MOB_KEY);
  if (legacyMobId) {
    if (!loadRememberedMobUser()) {
      const legacyEmp = state.employees.find((e) => e.id === legacyMobId);
      if (legacyEmp) {
        saveRememberedMobUser({
          employeeId: legacyEmp.id,
          name: legacyEmp.name,
          ci: legacyEmp.ci,
          sector: legacyEmp.sector,
        });
      }
    }
    localStorage.removeItem(MOB_KEY);
  }

  const params = new URLSearchParams(window.location.search);
  const urlMode = params.get('mode');
  const savedLayout = (localStorage.getItem(LAYOUT_KEY) as LayoutMode) || 'both';

  if (urlMode === 'mobile' || window.innerWidth <= 900) {
    setLayout('mobile');
  } else {
    setLayout(savedLayout);
  }

  const t = todayStr();
  const m = currentMonthStr();
  const y = currentYearStr();

  const setDefault = (id: string, val: string) => {
    const el = $<HTMLInputElement>(id);
    if (el && !el.value) el.value = val;
  };
  setDefault('calMonth', m);
  setDefault('gpsDate', t);
  setDefault('mDate', t);
  setDefault('hMonth', m);
  setDefault('newEmpHireDate', t);
  setDefault('legHireDate', t);
  setDefault('legExitDate', t);
  setDefault('extFrom', `${m}-01`);
  setDefault('extTo', t);
  setDefault('expDate', t);
  setDefault('expFilterDay', t);
  setDefault('expFilterMonth', m);
  setDefault('expFilterYear', y);
  setDefault('expFilterFrom', `${m}-01`);
  setDefault('expFilterTo', t);
  setDefault('rankFrom', `${m}-01`);
  setDefault('rankTo', t);
  setDefault('rankMonth', m);
  setDefault('rankYear', y);

  renderLegalExtraRows();
  initPwaListeners();
  renderAll();
  if (localStorage.getItem(ADM_KEY) === '1') {
    openTab('portada');
  }
  startClock();

  const conn = await testConnection();
  if (!conn.online) {
    showToast(conn.message, 'err');
  }

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (user && user.emailVerified) {
      void attachFirestoreListeners(user).then(() => {
        if (getActiveMobEmployee()) startGpsLoop();
      });
    } else {
      isCloudAdmin = false;
      detachListeners();
      stopGpsLoop();
      updateConnectionBadges();
      renderMobShell();
    }
  });
}

void bootstrap();
