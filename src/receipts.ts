import { escapeHtml, fmtGs, SUPPORT_WHATSAPP, todayStr } from './utils';

export interface ReceiptDocument {
  title: string;
  subtitle: string;
  companyLogo: string;
  bodyHtml: string;
  plainTextSummary: string;
  showSignatures?: boolean;
}

export function buildWhatsappUrls(text: string): { supportUrl: string; anyContactUrl: string } {
  const encoded = encodeURIComponent(text);
  return {
    supportUrl: `https://wa.me/${SUPPORT_WHATSAPP}?text=${encoded}`,
    anyContactUrl: `https://wa.me/?text=${encoded}`,
  };
}

export function renderPrintableReceipt(doc: ReceiptDocument): string {
  const logoSrc = doc.companyLogo || '/icon-192.png';
  const sigBlock =
    doc.showSignatures !== false
      ? `<div class="rec-sigs">
          <div class="rec-sig-col">
            <div class="rec-sig-line"></div>
            <div><strong>Firma del Empleador / RRHH</strong></div>
            <div style="font-size:11px;color:#475569">CARL PETERS — Paraguay</div>
          </div>
          <div class="rec-sig-col">
            <div class="rec-sig-line"></div>
            <div><strong>Firma del Funcionario / Conforme</strong></div>
            <div style="font-size:11px;color:#475569">Aclaración y N° de C.I.</div>
          </div>
        </div>`
      : '';

  return `<div class="rec-sheet">
    <div class="rec-head">
      <div style="display:flex;align-items:center;gap:12px">
        <img src="${escapeHtml(logoSrc)}" alt="Logo" style="height:48px;max-width:120px;object-fit:contain;background:#fff;border-radius:6px;padding:3px;border:1px solid #cbd5e1"/>
        <div>
          <div style="font-size:18px;font-weight:900;letter-spacing:.3px">CARL PETERS</div>
          <div style="font-size:12px;color:#475569">Asistencia, Nómina &amp; Control de Obra — Paraguay 2026</div>
        </div>
      </div>
      <div style="text-align:right;font-size:11px;color:#334155">
        <div><strong>Fecha de emisión:</strong> ${escapeHtml(todayStr())}</div>
        <div><strong>Moneda:</strong> Guaraníes (PYG)</div>
      </div>
    </div>
    <div style="margin:12px 0;padding-bottom:8px;border-bottom:2px solid #0f172a">
      <div style="font-size:15px;font-weight:800">${escapeHtml(doc.title)}</div>
      <div style="font-size:12px;color:#475569;margin-top:2px">${escapeHtml(doc.subtitle)}</div>
    </div>
    <div class="rec-body">${doc.bodyHtml}</div>
    ${sigBlock}
  </div>`;
}

export function triggerPrintReceipt(doc: ReceiptDocument): void {
  const sheet = document.getElementById('printReceiptSheet');
  if (!sheet) return;
  sheet.innerHTML = renderPrintableReceipt(doc);
  document.body.classList.add('printing-receipt');
  window.print();
  window.setTimeout(() => {
    document.body.classList.remove('printing-receipt');
  }, 500);
}

export function downloadReceiptHtmlForPdf(filename: string, doc: ReceiptDocument): void {
  const inner = renderPrintableReceipt(doc);
  const fullHtml = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(doc.title)} — CARL PETERS</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px}
.rec-sheet{background:#fff;max-width:820px;margin:0 auto;padding:24px;border:1px solid #cbd5e1;border-radius:12px}
.rec-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}
th,td{padding:7px 8px;border:1px solid #cbd5e1;text-align:left}
th{background:#f1f5f9}
.rec-sigs{display:grid;grid-template-columns:1fr 1fr;gap:36px;margin-top:44px;text-align:center;font-size:12px}
.rec-sig-line{border-top:1.5px solid #0f172a;margin-bottom:6px}
.no-print{margin-bottom:14px;text-align:right}
.btn{background:#0f172a;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
@media print{body{background:#fff;padding:0}.rec-sheet{border:none;max-width:100%;padding:0}.no-print{display:none}}
</style>
</head>
<body>
<div class="no-print"><button class="btn" onclick="window.print()">🖨️ Guardar como PDF / Imprimir</button></div>
${inner}
</body>
</html>`;
  const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function fmtGsRow(label: string, value: number, highlight = false): string {
  const style = highlight ? 'font-weight:800;background:#f1f5f9' : '';
  return `<tr style="${style}"><td>${escapeHtml(label)}</td><td style="text-align:right;font-weight:700">${escapeHtml(fmtGs(value))}</td></tr>`;
}
