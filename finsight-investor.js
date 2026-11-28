/* ============================================================
   FINSIGHT — FRONTEND CONTROLLER (browser only)

   Talks to the backend through:
     GET  /api/session
     POST /api/login
     POST /api/logout
     POST /api/ai/extract-financials   (multipart field: report)
     GET  /api/admin/usage.xlsx        (admin only)

   Expected extraction response:
     { ok, company, financials[], validation, provider, model }
   All monetary values arrive as numbers in INR crore.
   ============================================================ */

"use strict";

const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

const state = {
  session: null,
  company: null,
  financials: [],
  validation: { consolidated_preferred: false, years_found: [], warnings: [] },
  selectedIndex: -1,
  activeTab: "financials",
  busy: false
};

let statusTimers = [];


/* ============================================================
   1. DOM + FORMAT HELPERS
   ============================================================ */

function byId(id) {
  return document.getElementById(id);
}

function show(element) {
  if (element) {
    element.hidden = false;
  }
}

function hide(element) {
  if (element) {
    element.hidden = true;
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function finite(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = typeof value === "number" ? value : Number(value);

  return Number.isFinite(number) ? number : null;
}

function divide(a, b) {
  const x = finite(a);
  const y = finite(b);

  return x === null || y === null || y === 0 ? null : x / y;
}

function average(a, b) {
  const x = finite(a);
  const y = finite(b);

  return x === null || y === null ? null : (x + y) / 2;
}

function formatNumber(value, decimals = 1) {
  const number = finite(value);

  if (number === null) {
    return "N/A";
  }

  return number.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function money(value) {
  const number = finite(value);

  if (number === null) {
    return "N/A";
  }

  const decimals = Math.abs(number) >= 100 ? 0 : 2;
  const text = formatNumber(Math.abs(number), decimals);

  return `${number < 0 ? "-" : ""}₹${text} Cr`;
}

function percent(value) {
  const number = finite(value);

  return number === null ? "N/A" : `${formatNumber(number, 1)}%`;
}

function multiple(value) {
  const number = finite(value);

  return number === null ? "N/A" : `${formatNumber(number, 2)}×`;
}

function days(value) {
  const number = finite(value);

  return number === null ? "N/A" : `${formatNumber(number, 0)} days`;
}

function sharesInCrore(value) {
  const number = finite(value);

  return number === null ? "N/A" : `${formatNumber(number / 1e7, 2)} Cr shares`;
}

function yearLabel(row) {
  return row.financial_year || String(row.year);
}


/* ============================================================
   2. API HELPER
   ============================================================ */

async function api(url, options = {}) {
  let response;

  try {
    response = await fetch(url, { credentials: "same-origin", ...options });
  } catch {
    throw new Error("Could not reach the FinSight server. Check your connection and try again.");
  }

  const type = response.headers.get("content-type") || "";
  let body = null;

  if (type.includes("application/json")) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  } else {
    const text = await response.text().catch(() => "");

    body = { ok: false, error: text.slice(0, 200) || `HTTP ${response.status}` };
  }

  if (!response.ok || body?.ok === false) {
    const error = new Error(body?.error || `Request failed (HTTP ${response.status}).`);

    error.status = response.status;
    throw error;
  }

  return body;
}


/* ============================================================
   3. EXTRACTION NORMALIZATION (defensive; backend already
      sends the strict contract)
   ============================================================ */

const NUMERIC_FIELDS = [
  "revenue", "total_income", "other_income", "ebitda", "net_income",
  "finance_cost", "total_assets", "current_assets", "current_liabilities",
  "total_debt", "cash", "total_equity", "inventory", "accounts_receivable",
  "accounts_payable", "operating_cash_flow", "capex", "shares_outstanding"
];

function normalizeRow(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const year = finite(raw.year);

  if (year === null) {
    return null;
  }

  const row = {
    financial_year: String(raw.financial_year || year),
    year,
    statement_basis: raw.statement_basis || "Consolidated",
    source_unit: raw.source_unit || "INR crore",
    source_pages: Array.isArray(raw.source_pages)
      ? raw.source_pages.filter(page => Number.isFinite(page))
      : [],
    extraction_notes: raw.extraction_notes || null
  };

  for (const field of NUMERIC_FIELDS) {
    row[field] = finite(raw[field]);
  }

  return row;
}

function normalizeExtraction(body) {
  if (!body || body.ok !== true || !Array.isArray(body.financials)) {
    throw new Error("The server returned an unexpected response.");
  }

  const financials = body.financials
    .map(normalizeRow)
    .filter(Boolean)
    .sort((a, b) => a.year - b.year);

  if (!financials.length) {
    throw new Error("No financial-year rows were extracted.");
  }

  const validation = body.validation || {};

  return {
    company: body.company || { name: "Company" },
    financials,
    validation: {
      consolidated_preferred: Boolean(validation.consolidated_preferred),
      years_found: Array.isArray(validation.years_found) ? validation.years_found : [],
      warnings: Array.isArray(validation.warnings) ? validation.warnings : []
    }
  };
}


/* ============================================================
   4. DERIVED METRICS (calculated locally from reported values)
   ============================================================ */

function calculatedMetrics(index) {
  const row = state.financials[index];
  const previous = index > 0 ? state.financials[index - 1] : null;

  if (!row) {
    return {};
  }

  const ebitdaMargin = divide(row.ebitda, row.revenue);
  const netMargin = divide(row.net_income, row.revenue);

  // Prefer average balances when the prior year exists; fall back to closing.
  const equityBase = previous
    ? average(row.total_equity, previous.total_equity)
    : row.total_equity;
  const assetBase = previous
    ? average(row.total_assets, previous.total_assets)
    : row.total_assets;

  const roe = divide(row.net_income, equityBase ?? row.total_equity);
  const roa = divide(row.net_income, assetBase ?? row.total_assets);

  const netDebt =
    finite(row.total_debt) !== null && finite(row.cash) !== null
      ? row.total_debt - row.cash
      : null;

  const fcf =
    finite(row.operating_cash_flow) !== null && finite(row.capex) !== null
      ? row.operating_cash_flow - row.capex
      : null;

  const cashConversion =
    finite(row.net_income) !== null && row.net_income > 0
      ? divide(row.operating_cash_flow, row.net_income)
      : null;

  const receivableDays = divide(row.accounts_receivable, row.revenue);

  return {
    ebitdaMargin: ebitdaMargin === null ? null : ebitdaMargin * 100,
    netMargin: netMargin === null ? null : netMargin * 100,
    roe: roe === null ? null : roe * 100,
    roa: roa === null ? null : roa * 100,
    roeUsesAverage: Boolean(previous) && equityBase !== null && average(row.total_equity, previous.total_equity) !== null,
    roaUsesAverage: Boolean(previous) && assetBase !== null && average(row.total_assets, previous.total_assets) !== null,
    currentRatio: divide(row.current_assets, row.current_liabilities),
    debtEquity: divide(row.total_debt, row.total_equity),
    netDebt,
    fcf,
    cashConversion,
    receivableDays: receivableDays === null ? null : receivableDays * 365,
    revenueGrowth:
      previous && finite(previous.revenue) && previous.revenue > 0 && finite(row.revenue) !== null
        ? ((row.revenue - previous.revenue) / previous.revenue) * 100
        : null
  };
}


/* ============================================================
   5. SESSION / LOGIN
   ============================================================ */

function showLogin() {
  show(byId("loginGate"));
  hide(byId("app"));
}

function enterApplication() {
  hide(byId("loginGate"));
  show(byId("app"));

  const download = byId("usageDownload");

  if (download) {
    download.hidden = !state.session?.admin;
  }
}

function resetDashboard() {
  state.company = null;
  state.financials = [];
  state.validation = { consolidated_preferred: false, years_found: [], warnings: [] };
  state.selectedIndex = -1;

  hide(byId("companyWorkspace"));
  byId("uploadStatus").textContent = "No report loaded.";
  hideError();
}

async function checkSession() {
  try {
    const session = await api("/api/session");

    if (session.authenticated) {
      state.session = { name: session.name, admin: session.admin };
      enterApplication();
      return;
    }
  } catch {
    // fall through to login
  }

  showLogin();
}

async function login(event) {
  event.preventDefault();

  const errorBox = byId("loginError");
  const button = event.target.querySelector("button[type=submit]");

  hide(errorBox);
  button.disabled = true;

  try {
    const result = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: byId("loginName").value,
        password: byId("loginPassword").value
      })
    });

    state.session = { name: result.name, admin: result.admin };
    byId("loginPassword").value = "";
    enterApplication();
  } catch (error) {
    errorBox.textContent = error.message;
    show(errorBox);
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // the cookie is cleared server-side when possible; still leave the app
  }

  state.session = null;
  resetDashboard();
  byId("loginName").value = "";
  showLogin();
}

async function downloadUsage() {
  const button = byId("usageDownload");
  const original = button.textContent;

  button.disabled = true;
  button.textContent = "Preparing…";

  try {
    const response = await fetch("/api/admin/usage.xlsx", { credentials: "same-origin" });

    if (!response.ok) {
      let message = `Download failed (HTTP ${response.status}).`;

      try {
        message = (await response.json()).error || message;
      } catch {
        // keep default
      }

      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] || "finsight-usage.xlsx";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}


/* ============================================================
   6. UPLOAD + EXTRACTION
   ============================================================ */

function setStatus(message) {
  byId("uploadStatus").textContent = message;
}

function clearStatusTimers() {
  statusTimers.forEach(clearTimeout);
  statusTimers = [];
}

function showError(message) {
  const box = byId("error");

  box.textContent = message;
  show(box);
}

function hideError() {
  const box = byId("error");

  box.textContent = "";
  hide(box);
}

async function uploadReport(event) {
  const input = event.target;
  const file = input.files?.[0];

  if (!file || state.busy) {
    return;
  }

  hideError();

  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    showError("Only PDF files are accepted.");
    input.value = "";
    return;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    showError("PDF exceeds 45 MB.");
    input.value = "";
    return;
  }

  const previousStatus = byId("uploadStatus").textContent;
  const form = new FormData();

  form.append("report", file);

  state.busy = true;
  byId("uploadCard").classList.add("uploading");
  setStatus("Uploading report…");

  statusTimers.push(
    setTimeout(() => setStatus("Extracting audited financial statements…"), 3000)
  );

  try {
    const body = await api("/api/ai/extract-financials", { method: "POST", body: form });

    clearStatusTimers();
    setStatus("Validating financial data…");

    const result = normalizeExtraction(body);

    state.company = result.company;
    state.financials = result.financials;
    state.validation = result.validation;
    state.selectedIndex = result.financials.length - 1;
    state.activeTab = "financials";

    renderDashboard();

    const count = result.financials.length;
    const notes = result.validation.warnings.length;

    setStatus(
      `${state.company.name}: ${count} reporting year${count === 1 ? "" : "s"} extracted successfully.` +
        (notes ? ` ${notes} review note${notes === 1 ? "" : "s"} in Report evidence.` : "")
    );
  } catch (error) {
    clearStatusTimers();

    if (error.status === 401) {
      state.session = null;
      showLogin();
      return;
    }

    // Keep the previous valid dashboard and show the real reason.
    setStatus(state.financials.length ? previousStatus : "No report loaded.");
    showError(error.message);
  } finally {
    state.busy = false;
    byId("uploadCard").classList.remove("uploading");
    input.value = "";
  }
}


/* ============================================================
   7. RENDERING
   ============================================================ */

function renderDashboard() {
  show(byId("companyWorkspace"));

  renderCompanyHeader();
  renderYearControls();
  renderMetrics();
  renderFinancialHistory();
  renderPerformanceChart();
  renderHealthScore();
  renderSignals();
  renderResearchTabs();
  renderResearchPanel();
}

function selectedRow() {
  return state.financials[state.selectedIndex] || null;
}

function renderCompanyHeader() {
  const company = state.company || {};
  const row = state.financials[state.financials.length - 1];

  byId("companyName").textContent = company.name || "Company";

  const parts = [
    company.exchange && company.ticker ? `${company.exchange}: ${company.ticker}` : company.ticker,
    company.isin,
    row ? `${row.statement_basis} statements` : null,
    "Values in ₹ crore"
  ].filter(Boolean);

  byId("companyMeta").textContent = parts.join("  ·  ");
}

function renderYearControls() {
  const container = byId("yearControls");

  container.innerHTML = "";

  if (state.financials.length < 2) {
    hide(container);
    return;
  }

  state.financials.forEach((row, index) => {
    const button = document.createElement("button");

    button.type = "button";
    button.textContent = `FY ${yearLabel(row)}`;
    button.classList.toggle("active", index === state.selectedIndex);

    button.addEventListener("click", () => {
      state.selectedIndex = index;
      renderYearControls();
      renderMetrics();
      renderHealthScore();
      renderSignals();
      renderResearchPanel();
    });

    container.appendChild(button);
  });

  show(container);
}

function metricCard(label, value, note) {
  return `
    <article class="metric">
      <div class="metric-label">${escapeHTML(label)}</div>
      <div class="metric-value">${escapeHTML(value)}</div>
      <div class="metric-note">${escapeHTML(note || "")}</div>
    </article>
  `;
}

function renderMetrics() {
  const row = selectedRow();

  if (!row) {
    return;
  }

  const m = calculatedMetrics(state.selectedIndex);
  const isLatest = state.selectedIndex === state.financials.length - 1;

  byId("snapshotTitle").textContent =
    `${isLatest ? "Latest financial snapshot" : "Financial snapshot"} · FY ${yearLabel(row)}`;

  const reported = `Reported · FY ${yearLabel(row)}`;

  byId("metrics").innerHTML = [
    metricCard("Revenue", money(row.revenue), reported),
    metricCard("EBITDA", money(row.ebitda), reported),
    metricCard("Net profit", money(row.net_income), reported),
    metricCard("EBITDA margin", percent(m.ebitdaMargin), "EBITDA ÷ revenue"),
    metricCard("Net margin", percent(m.netMargin), "Net profit ÷ revenue"),
    metricCard("ROE", percent(m.roe), m.roeUsesAverage ? "Net profit ÷ average equity" : "Net profit ÷ closing equity"),
    metricCard("ROA", percent(m.roa), m.roaUsesAverage ? "Net profit ÷ average assets" : "Net profit ÷ closing assets"),
    metricCard("Current ratio", multiple(m.currentRatio), "Current assets ÷ current liabilities"),
    metricCard("Net debt", money(m.netDebt), "Total debt − cash"),
    metricCard("Simplified FCF", money(m.fcf), "Operating cash flow − capex"),
    metricCard("Cash conversion", multiple(m.cashConversion), "Operating cash flow ÷ net profit"),
    metricCard("Receivable days", days(m.receivableDays), "Trade receivables ÷ revenue × 365")
  ].join("");
}

function renderFinancialHistory() {
  const rows = state.financials;

  byId("financialHistoryHead").innerHTML =
    "<th>Metric</th>" +
    rows.map(row => `<th>${escapeHTML(yearLabel(row))}</th>`).join("");

  const computed = rows.map((_, index) => calculatedMetrics(index));

  const lines = [
    ["Revenue", r => money(r.revenue)],
    ["EBITDA", r => money(r.ebitda)],
    ["Net profit", r => money(r.net_income)],
    ["EBITDA margin", (r, m) => percent(m.ebitdaMargin)],
    ["Net margin", (r, m) => percent(m.netMargin)],
    ["ROE", (r, m) => percent(m.roe)],
    ["ROA", (r, m) => percent(m.roa)],
    ["Current ratio", (r, m) => multiple(m.currentRatio)],
    ["Total assets", r => money(r.total_assets)],
    ["Total equity", r => money(r.total_equity)],
    ["Total debt", r => money(r.total_debt)],
    ["Cash", r => money(r.cash)],
    ["Net debt", (r, m) => money(m.netDebt)],
    ["Operating cash flow", r => money(r.operating_cash_flow)],
    ["Capex", r => money(r.capex)],
    ["Simplified FCF", (r, m) => money(m.fcf)],
    ["Cash conversion", (r, m) => multiple(m.cashConversion)],
    ["Receivable days", (r, m) => days(m.receivableDays)]
  ];

  byId("financialHistoryBody").innerHTML = lines
    .map(
      ([label, format]) => `
        <tr>
          <td>${escapeHTML(label)}</td>
          ${rows.map((row, index) => `<td>${escapeHTML(format(row, computed[index]))}</td>`).join("")}
        </tr>`
    )
    .join("");
}


/* ---------- Chart (canvas, responsive, DPR-aware) ---------- */

const CHART_SERIES = [
  { key: "revenue", label: "Revenue", color: "#0e4b3e" },
  { key: "ebitda", label: "EBITDA", color: "#3f9c80" },
  { key: "net_income", label: "Net profit", color: "#b5de55" }
];

function niceStep(maxValue, ticks) {
  const raw = maxValue / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;

  return nice * power;
}

function compactMoney(value) {
  const number = finite(value);

  if (number === null) {
    return "";
  }

  const abs = Math.abs(number);
  const text =
    abs >= 1000 ? `${formatNumber(abs / 1000, 1)}k` : formatNumber(abs, abs >= 100 ? 0 : 1);

  return `${number < 0 ? "-" : ""}${text}`;
}

function renderPerformanceChart() {
  const canvas = byId("performanceChart");
  const shell = canvas?.parentElement;

  if (!canvas || !shell || !state.financials.length) {
    return;
  }

  const width = Math.floor(shell.clientWidth);
  const height = Math.floor(shell.clientHeight);

  if (width < 60 || height < 60) {
    return;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext("2d");

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const compact = width < 520;
  const font = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
  const rows = state.financials;

  const values = rows.flatMap(row => CHART_SERIES.map(series => finite(row[series.key])).filter(v => v !== null));

  if (!values.length) {
    ctx.fillStyle = "#74877f";
    ctx.font = `14px ${font}`;
    ctx.textAlign = "center";
    ctx.fillText("No chartable values were extracted.", width / 2, height / 2);
    return;
  }

  const maxValue = Math.max(0, ...values);
  const minValue = Math.min(0, ...values);
  const step = niceStep(Math.max(maxValue - minValue, 1), compact ? 4 : 5);
  const top = Math.ceil(maxValue / step) * step || step;
  const bottom = Math.floor(minValue / step) * step;

  const padding = { left: compact ? 44 : 64, right: 12, top: 44, bottom: 34 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const y = value => padding.top + ((top - value) / (top - bottom)) * plotH;

  // grid + axis labels
  ctx.font = `${compact ? 10 : 12}px ${font}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let tick = bottom; tick <= top + step / 2; tick += step) {
    const ty = y(tick);

    ctx.strokeStyle = tick === 0 ? "#9fb0a8" : "#e3ebe6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, ty);
    ctx.lineTo(width - padding.right, ty);
    ctx.stroke();

    ctx.fillStyle = "#74877f";
    ctx.fillText(compactMoney(tick), padding.left - 8, ty);
  }

  // legend
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `${compact ? 11 : 13}px ${font}`;

  let legendX = padding.left;

  for (const series of CHART_SERIES) {
    ctx.fillStyle = series.color;
    ctx.fillRect(legendX, 14, 12, 12);
    ctx.fillStyle = "#183f37";
    ctx.fillText(series.label, legendX + 18, 20);
    legendX += 18 + ctx.measureText(series.label).width + (compact ? 14 : 24);
  }

  // bars
  const groupW = plotW / rows.length;
  const groupInner = Math.min(groupW * 0.72, 220);
  const barW = groupInner / CHART_SERIES.length;
  const showLabels = barW >= 30;

  rows.forEach((row, rowIndex) => {
    const groupX = padding.left + groupW * rowIndex + (groupW - groupInner) / 2;

    CHART_SERIES.forEach((series, seriesIndex) => {
      const value = finite(row[series.key]);

      if (value === null) {
        return;
      }

      const x = groupX + seriesIndex * barW + 1;
      const y0 = y(0);
      const y1 = y(value);

      ctx.fillStyle = series.color;
      ctx.fillRect(x, Math.min(y0, y1), Math.max(barW - 2, 1), Math.max(Math.abs(y1 - y0), 1));

      if (showLabels) {
        ctx.fillStyle = "#183f37";
        ctx.font = `${compact ? 9 : 11}px ${font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = value >= 0 ? "bottom" : "top";
        ctx.fillText(compactMoney(value), x + (barW - 2) / 2, value >= 0 ? y1 - 3 : y1 + 3);
      }
    });

    ctx.fillStyle = "#183f37";
    ctx.font = `${compact ? 11 : 13}px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(yearLabel(row), groupX + groupInner / 2, height - padding.bottom + 10);
  });
}


/* ---------- Financial health (FinSight heuristic) ---------- */

function bandScore(value, bands) {
  if (finite(value) === null) {
    return null;
  }

  for (const [test, score] of bands) {
    if (test(value)) {
      return score;
    }
  }

  return null;
}

function healthCategories(m) {
  const average = list => {
    const valid = list.filter(item => item !== null);

    return valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
  };

  return [
    {
      label: "Profitability",
      score: average([
        bandScore(m.netMargin, [[x => x >= 15, 95], [x => x >= 8, 75], [x => x >= 3, 55], [x => x >= 0, 35], [() => true, 15]]),
        bandScore(m.roe, [[x => x >= 18, 95], [x => x >= 12, 75], [x => x >= 6, 55], [x => x >= 0, 35], [() => true, 15]])
      ])
    },
    {
      label: "Liquidity",
      score: bandScore(m.currentRatio, [[x => x >= 2, 95], [x => x >= 1.5, 82], [x => x >= 1.1, 62], [x => x >= 1, 45], [() => true, 20]])
    },
    {
      label: "Leverage",
      score: bandScore(m.debtEquity, [[x => x <= 0.3, 95], [x => x <= 0.7, 80], [x => x <= 1.2, 60], [x => x <= 2, 40], [() => true, 20]])
    },
    {
      label: "Cash conversion",
      score: bandScore(m.cashConversion, [[x => x >= 1, 95], [x => x >= 0.8, 78], [x => x >= 0.5, 55], [x => x >= 0, 35], [() => true, 15]])
    },
    {
      label: "Efficiency",
      score: bandScore(m.receivableDays, [[x => x <= 30, 92], [x => x <= 60, 75], [x => x <= 90, 55], [x => x <= 150, 38], [() => true, 20]])
    }
  ];
}

function renderHealthScore() {
  const m = calculatedMetrics(state.selectedIndex);
  const categories = healthCategories(m);
  const scored = categories.filter(item => item.score !== null);

  // Categories without data are excluded, never treated as zero.
  const overall = scored.length
    ? Math.round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length)
    : null;

  byId("scoreValue").textContent = overall === null ? "—" : String(overall);

  byId("scoreLabel").textContent =
    overall === null
      ? "Not enough data to score"
      : overall >= 75
        ? "Strong"
        : overall >= 55
          ? "Moderate"
          : overall >= 40
            ? "Weak"
            : "Stressed";

  byId("scoreBars").innerHTML =
    categories
      .map(item =>
        item.score === null
          ? `<div class="score-bar-row">
               <span class="score-bar-label">${escapeHTML(item.label)}</span>
               <div class="score-bar-track"></div>
               <span class="score-bar-value">N/A</span>
             </div>`
          : `<div class="score-bar-row">
               <span class="score-bar-label">${escapeHTML(item.label)}</span>
               <div class="score-bar-track"><div class="score-bar-fill" style="width:${item.score}%"></div></div>
               <span class="score-bar-value">${item.score}</span>
             </div>`
      )
      .join("") +
    `<p class="score-footnote">${scored.length} of ${categories.length} categories scored. Categories without supporting data are excluded.</p>`;
}


/* ---------- Investor signals (deterministic) ---------- */

function buildSignals(row, m) {
  const good = [];
  const bad = [];
  const watch = [];
  const add = (list, title, explanation) => list.push({ title, explanation });

  if (m.revenueGrowth !== null) {
    const text = `Revenue changed ${percent(m.revenueGrowth)} versus the previous year.`;

    if (m.revenueGrowth >= 10) add(good, "Revenue momentum", text);
    else if (m.revenueGrowth < 0) add(bad, "Revenue momentum", text);
    else add(watch, "Revenue momentum", text);
  }

  if (m.ebitdaMargin !== null) {
    const text = `EBITDA margin is ${percent(m.ebitdaMargin)}. Margin levels vary widely by sector.`;

    if (m.ebitdaMargin >= 20) add(good, "EBITDA margin", text);
    else if (m.ebitdaMargin < 8) add(bad, "EBITDA margin", text);
    else add(watch, "EBITDA margin", text);
  }

  if (finite(row.net_income) !== null && row.net_income < 0) {
    add(bad, "Profitability", "The company reported a net loss for this year.");
  }

  if (m.cashConversion !== null) {
    const text = `Operating cash flow is ${multiple(m.cashConversion)} of net profit.`;

    if (m.cashConversion >= 0.8) add(good, "Earnings cash conversion", text);
    else if (m.cashConversion < 0.5) add(bad, "Earnings cash conversion", text);
    else add(watch, "Earnings cash conversion", text);
  }

  if (m.fcf !== null && m.fcf < 0) {
    add(bad, "Free cash flow", `Simplified free cash flow is ${money(m.fcf)} (operating cash flow less capex).`);
  } else if (m.fcf !== null && m.fcf > 0) {
    add(good, "Free cash flow", `Simplified free cash flow is positive at ${money(m.fcf)}.`);
  }

  if (m.netDebt !== null && m.netDebt < 0) {
    add(good, "Net cash position", `Cash exceeds debt by ${money(Math.abs(m.netDebt))}.`);
  }

  if (m.debtEquity !== null) {
    const text = `Total debt is ${multiple(m.debtEquity)} of total equity.`;

    if (m.debtEquity <= 0.5) add(good, "Balance-sheet leverage", text);
    else if (m.debtEquity > 1.5) add(bad, "Balance-sheet leverage", text);
    else add(watch, "Balance-sheet leverage", text);
  }

  if (m.currentRatio !== null) {
    const text = `Current ratio is ${multiple(m.currentRatio)}.`;

    if (m.currentRatio >= 1.5) add(good, "Liquidity", text);
    else if (m.currentRatio < 1) add(bad, "Liquidity", text);
    else add(watch, "Liquidity", text);
  }

  if (m.roe !== null) {
    const text = `Return on equity is ${percent(m.roe)}.`;

    if (m.roe >= 15) add(good, "ROE", text);
    else if (m.roe < 8) add(bad, "ROE", text);
    else add(watch, "ROE", text);
  }

  const previous = state.selectedIndex > 0 ? state.financials[state.selectedIndex - 1] : null;
  const previousMetrics = previous ? calculatedMetrics(state.selectedIndex - 1) : null;

  if (m.receivableDays !== null && previousMetrics?.receivableDays) {
    const change = (m.receivableDays / previousMetrics.receivableDays - 1) * 100;
    const text = `Receivable days moved from ${days(previousMetrics.receivableDays)} to ${days(m.receivableDays)}.`;

    if (change > 20) add(watch, "Receivables", text);
    else if (change < -10) add(good, "Receivables", text);
  }

  return { good, bad, watch };
}

function renderSignalList(id, items) {
  byId(id).innerHTML = items.length
    ? items
        .map(
          item => `
            <div class="signal-item">
              <strong>${escapeHTML(item.title)}</strong>
              <p>${escapeHTML(item.explanation)}</p>
            </div>`
        )
        .join("")
    : `<div class="signal-item"><p>No supported signal available.</p></div>`;
}

function renderSignals() {
  const row = selectedRow();

  if (!row) {
    return;
  }

  const signals = buildSignals(row, calculatedMetrics(state.selectedIndex));

  renderSignalList("goodList", signals.good);
  renderSignalList("badList", signals.bad);
  renderSignalList("watchList", signals.watch);
}


/* ---------- Company fundamentals tabs ---------- */

const RESEARCH_TABS = [
  ["financials", "Financials"],
  ["cash", "Cash & earnings"],
  ["working", "Working capital"],
  ["debt", "Debt"],
  ["returns", "Returns"],
  ["evidence", "Report evidence"],
  ["checklist", "Investor checklist"]
];

function renderResearchTabs() {
  const container = byId("sectionTabs");

  container.innerHTML = "";

  for (const [key, label] of RESEARCH_TABS) {
    const button = document.createElement("button");

    button.type = "button";
    button.textContent = label;
    button.classList.toggle("active", key === state.activeTab);

    button.addEventListener("click", () => {
      state.activeTab = key;
      renderResearchTabs();
      renderResearchPanel();
    });

    container.appendChild(button);
  }
}

function panelCard(title, value, description) {
  return `
    <article class="panel-card">
      <h4>${escapeHTML(title)}</h4>
      <strong>${escapeHTML(value)}</strong>
      <p>${escapeHTML(description || "")}</p>
    </article>`;
}

function checklistItem(title, pass, detail) {
  const value = pass === null ? "N/A" : pass ? "Yes" : "No";

  return panelCard(title, value, detail);
}

function renderResearchPanel() {
  const row = selectedRow();
  const panel = byId("sectionPanel");

  if (!row) {
    panel.innerHTML = "";
    return;
  }

  const m = calculatedMetrics(state.selectedIndex);
  const label = `FY ${yearLabel(row)}`;
  let cards = [];

  switch (state.activeTab) {
    case "financials":
      cards = [
        panelCard("Revenue", money(row.revenue), `${label}, revenue from operations`),
        panelCard("Total income", money(row.total_income), `${label}, includes other income`),
        panelCard("Other income", money(row.other_income), label),
        panelCard("EBITDA", money(row.ebitda), label),
        panelCard("Net profit", money(row.net_income), label),
        panelCard("Finance costs", money(row.finance_cost), label),
        panelCard("Total assets", money(row.total_assets), label),
        panelCard("Total equity", money(row.total_equity), label),
        panelCard("Shares outstanding", sharesInCrore(row.shares_outstanding), label)
      ];
      break;

    case "cash":
      cards = [
        panelCard("Operating cash flow", money(row.operating_cash_flow), label),
        panelCard("Capex", money(row.capex), label),
        panelCard("Simplified FCF", money(m.fcf), "Operating cash flow − capex"),
        panelCard("Net profit", money(row.net_income), label),
        panelCard("Cash conversion", multiple(m.cashConversion), "Operating cash flow ÷ net profit (profitable years only)"),
        panelCard("Cash", money(row.cash), label)
      ];
      break;

    case "working":
      cards = [
        panelCard("Current assets", money(row.current_assets), label),
        panelCard("Current liabilities", money(row.current_liabilities), label),
        panelCard("Current ratio", multiple(m.currentRatio), "Current assets ÷ current liabilities"),
        panelCard("Trade receivables", money(row.accounts_receivable), label),
        panelCard("Receivable days", days(m.receivableDays), "Trade receivables ÷ revenue × 365"),
        panelCard("Inventories", money(row.inventory), label),
        panelCard("Trade payables", money(row.accounts_payable), label)
      ];
      break;

    case "debt":
      cards = [
        panelCard("Total debt", money(row.total_debt), `${label}, current + non-current borrowings`),
        panelCard("Cash", money(row.cash), label),
        panelCard("Net debt", money(m.netDebt), "Total debt − cash"),
        panelCard("Debt / equity", multiple(m.debtEquity), "Total debt ÷ total equity"),
        panelCard("Finance costs", money(row.finance_cost), label)
      ];
      break;

    case "returns":
      cards = [
        panelCard("ROE", percent(m.roe), m.roeUsesAverage ? "Net profit ÷ average equity" : "Net profit ÷ closing equity"),
        panelCard("ROA", percent(m.roa), m.roaUsesAverage ? "Net profit ÷ average assets" : "Net profit ÷ closing assets"),
        panelCard("EBITDA margin", percent(m.ebitdaMargin), "EBITDA ÷ revenue"),
        panelCard("Net margin", percent(m.netMargin), "Net profit ÷ revenue")
      ];
      break;

    case "evidence": {
      const pages = row.source_pages.length ? row.source_pages.join(", ") : "Not reported";
      const warnings = state.validation.warnings;

      cards = [
        panelCard("Statement basis", row.statement_basis, "Consolidated statements are preferred whenever the report contains them."),
        panelCard("Source pages (PDF)", pages, label),
        panelCard("Source unit", row.source_unit, "Normalized to ₹ crore by FinSight before display."),
        panelCard("Extraction notes", row.extraction_notes || "None", label),
        panelCard("Years found", state.validation.years_found.join(", ") || "—", state.validation.consolidated_preferred ? "All years use consolidated statements." : "Not every year uses consolidated statements.")
      ];

      panel.innerHTML =
        `<div class="panel-grid">${cards.join("")}</div>` +
        `<div class="evidence-warnings">
           <h4>Validation notes</h4>
           ${
             warnings.length
               ? `<ul>${warnings.map(item => `<li>${escapeHTML(item)}</li>`).join("")}</ul>`
               : "<p>No validation warnings were raised.</p>"
           }
         </div>`;
      return;
    }

    case "checklist": {
      cards = [
        checklistItem("Revenue grew year over year", m.revenueGrowth === null ? null : m.revenueGrowth > 0, m.revenueGrowth === null ? "Needs two years of revenue." : `Change: ${percent(m.revenueGrowth)}`),
        checklistItem("Net profit is positive", finite(row.net_income) === null ? null : row.net_income > 0, money(row.net_income)),
        checklistItem("Operating cash flow covers net profit", m.cashConversion === null ? null : m.cashConversion >= 1, `Cash conversion: ${multiple(m.cashConversion)}`),
        checklistItem("Free cash flow is positive", m.fcf === null ? null : m.fcf > 0, money(m.fcf)),
        checklistItem("Current ratio is at least 1", m.currentRatio === null ? null : m.currentRatio >= 1, multiple(m.currentRatio)),
        checklistItem("Debt / equity is at most 1", m.debtEquity === null ? null : m.debtEquity <= 1, multiple(m.debtEquity)),
        checklistItem("Net cash position", m.netDebt === null ? null : m.netDebt < 0, money(m.netDebt)),
        checklistItem("ROE is at least 12%", m.roe === null ? null : m.roe >= 12, percent(m.roe))
      ];

      panel.innerHTML =
        `<div class="panel-grid">${cards.join("")}</div>` +
        `<p class="section-intro checklist-note">A FinSight screening checklist with generic thresholds. It is not an investment recommendation.</p>`;
      return;
    }

    default:
      break;
  }

  panel.innerHTML = `<div class="panel-grid">${cards.join("")}</div>`;
}


/* ============================================================
   8. EVENTS + INIT
   ============================================================ */

function bindEvents() {
  byId("loginForm").addEventListener("submit", login);
  byId("logoutButton").addEventListener("click", logout);
  byId("usageDownload").addEventListener("click", downloadUsage);
  byId("companyFile").addEventListener("change", uploadReport);

  // Redraw the chart whenever its container changes size.
  const shell = byId("performanceChart").parentElement;

  if (typeof ResizeObserver === "function") {
    let frame = 0;

    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(renderPerformanceChart);
    }).observe(shell);
  } else {
    window.addEventListener("resize", renderPerformanceChart);
  }
}

async function init() {
  bindEvents();
  await checkSession();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
