/* ============================================================
   FINSIGHT AI — INVESTOR DASHBOARD
   Frontend controller

   Expected extraction response:
   {
     ok: true,
     company: {...},
     financials: [...]
   }
   ============================================================ */

"use strict";


/* ============================================================
   1. STATE
   ============================================================ */

const state = {
  session: null,

  company: null,

  financials: [],

  selectedYear: null,

  uploadedFile: null,

  reportAnalysis: null,

  performanceChart: null,

  activeResearchTab: "financials"
};


/* ============================================================
   2. DOM HELPERS
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


function setText(element, value) {
  if (!element) {
    return;
  }

  element.textContent =
    value == null || value === ""
      ? "—"
      : String(value);
}


function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


/* ============================================================
   3. NUMBER HELPERS
   ============================================================ */

function finite(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : null;
  }

  let text = String(value)
    .trim()
    .replace(/[₹,$£€]/g, "")
    .replace(/,/g, "");

  if (
    !text ||
    /^(n\/a|na|null|undefined|—|-)$/i.test(text)
  ) {
    return null;
  }

  let negative = false;

  if (
    text.startsWith("(") &&
    text.endsWith(")")
  ) {
    negative = true;

    text = text.slice(1, -1);
  }

  const number = Number(text);

  if (!Number.isFinite(number)) {
    return null;
  }

  return negative
    ? -number
    : number;
}


function divide(a, b) {
  const x = finite(a);
  const y = finite(b);

  if (
    x == null ||
    y == null ||
    y === 0
  ) {
    return null;
  }

  return x / y;
}


function average(a, b) {
  const x = finite(a);
  const y = finite(b);

  if (
    x == null ||
    y == null
  ) {
    return null;
  }

  return (x + y) / 2;
}


function percent(value) {
  const number = finite(value);

  if (number == null) {
    return "N/A";
  }

  return `${formatNumber(number, 1)}%`;
}


function multiple(value) {
  const number = finite(value);

  if (number == null) {
    return "N/A";
  }

  return `${formatNumber(number, 1)}×`;
}


function formatNumber(
  value,
  decimals = 1
) {
  const number = finite(value);

  if (number == null) {
    return "N/A";
  }

  return new Intl.NumberFormat(
    "en-IN",
    {
      maximumFractionDigits:
        decimals,

      minimumFractionDigits:
        Number.isInteger(number)
          ? 0
          : Math.min(1, decimals)
    }
  ).format(number);
}


function money(value) {
  const number = finite(value);

  if (number == null) {
    return "N/A";
  }

  return (
    "₹" +
    new Intl.NumberFormat(
      "en-IN",
      {
        maximumFractionDigits: 1
      }
    ).format(number) +
    " Cr"
  );
}


function days(value) {
  const number = finite(value);

  if (number == null) {
    return "N/A";
  }

  return `${formatNumber(number, 1)} days`;
}


/* ============================================================
   4. YEAR HELPERS
   ============================================================ */

function yearNumber(row) {
  const direct = finite(
    row?.year
  );

  if (direct != null) {
    return direct;
  }

  const matches = String(
    row?.financial_year || ""
  ).match(/20\d{2}/g);

  if (!matches?.length) {
    return null;
  }

  return Math.max(
    ...matches.map(Number)
  );
}


function yearLabel(row) {
  if (row?.financial_year) {
    return String(
      row.financial_year
    )
      .replace(/^FY/i, "")
      .trim();
  }

  const year =
    yearNumber(row);

  if (!year) {
    return "N/A";
  }

  return (
    `${year - 1}-` +
    String(year).slice(-2)
  );
}


function sortFinancials(rows) {
  return [...rows].sort(
    (a, b) =>
      (yearNumber(a) || 0) -
      (yearNumber(b) || 0)
  );
}


function latestRow() {
  if (!state.financials.length) {
    return null;
  }

  return state.financials[
    state.financials.length - 1
  ];
}


function selectedRow() {
  if (!state.financials.length) {
    return null;
  }

  if (
    state.selectedYear === null
  ) {
    return latestRow();
  }

  return (
    state.financials.find(
      row =>
        yearNumber(row) ===
        state.selectedYear
    ) ||
    latestRow()
  );
}


function previousRow(row) {
  if (!row) {
    return null;
  }

  const index =
    state.financials.indexOf(row);

  if (index <= 0) {
    return null;
  }

  return state.financials[
    index - 1
  ];
}


/* ============================================================
   5. NORMALIZE SERVER DATA
   ============================================================ */

function normalizeRow(
  row = {},
  companyName = ""
) {
  const year =
    yearNumber(row);

  return {
    company:
      row.company ||
      row.company_name ||
      companyName ||
      null,

    financial_year:
      row.financial_year ||
      row.financialYear ||
      (
        year
          ? `${year - 1}-${String(year).slice(-2)}`
          : null
      ),

    year,

    statement_basis:
      row.statement_basis ||
      row.statementBasis ||
      "Consolidated",

    source_unit:
      row.source_unit ||
      "INR crore",

    revenue: finite(
      row.revenue ??
      row.revenue_from_operations
    ),

    total_income: finite(
      row.total_income
    ),

    other_income: finite(
      row.other_income
    ),

    ebitda: finite(
      row.ebitda
    ),

    net_income: finite(
      row.net_income ??
      row.net_profit ??
      row.profit_after_tax ??
      row.pat ??
      row.profit_for_the_year
    ),

    finance_cost: finite(
      row.finance_cost ??
      row.finance_costs ??
      row.interest_expense
    ),

    total_assets: finite(
      row.total_assets
    ),

    current_assets: finite(
      row.current_assets ??
      row.total_current_assets
    ),

    current_liabilities: finite(
      row.current_liabilities ??
      row.total_current_liabilities
    ),

    total_debt: finite(
      row.total_debt ??
      row.total_borrowings ??
      row.borrowings
    ),

    cash: finite(
      row.cash ??
      row.cash_and_equivalents ??
      row.cash_and_cash_equivalents
    ),

    total_equity: finite(
      row.total_equity ??
      row.shareholders_equity ??
      row.shareholder_equity
    ),

    inventory: finite(
      row.inventory ??
      row.inventories
    ),

    accounts_receivable: finite(
      row.accounts_receivable ??
      row.receivables ??
      row.trade_receivables
    ),

    accounts_payable: finite(
      row.accounts_payable ??
      row.payables ??
      row.trade_payables
    ),

    operating_cash_flow: finite(
      row.operating_cash_flow ??
      row.cash_flow_from_operations ??
      row.net_cash_from_operating_activities
    ),

    capex: finite(
      row.capex ??
      row.capital_expenditure
    ),

    shares_outstanding: finite(
      row.shares_outstanding
    ),

    source_pages:
      Array.isArray(
        row.source_pages
      )
        ? row.source_pages
        : [],

    extraction_notes:
      row.extraction_notes ||
      null
  };
}


function normalizeExtraction(
  payload = {}
) {
  const root =
    payload?.result &&
    typeof payload.result === "object"
      ? payload.result
      : payload;

  const company =
    root?.company &&
    typeof root.company === "object"
      ? root.company
      : {};

  const companyName =
    company.name ||
    company.legal_name ||
    root.company_name ||
    "Unknown company";

  let rows =
    root.financials ||
    root.financial_rows ||
    root.financial_history ||
    [];

  if (
    !Array.isArray(rows) &&
    rows &&
    typeof rows === "object"
  ) {
    rows =
      Object.values(rows);
  }

  const financials =
    sortFinancials(
      (Array.isArray(rows)
        ? rows
        : []
      )
        .map(row =>
          normalizeRow(
            row,
            companyName
          )
        )
        .filter(
          row =>
            row.year ||
            row.financial_year
        )
    );

  if (!financials.length) {
    throw new Error(
      "The server returned no usable financial-year data."
    );
  }

  return {
    company: {
      ...company,

      name:
        company.name ||
        companyName,

      legal_name:
        company.legal_name ||
        companyName
    },

    financials
  };
}


/* ============================================================
   6. CALCULATED METRICS
   ============================================================ */

function calculatedMetrics(row) {
  if (!row) {
    return {};
  }

  const prior =
    previousRow(row);

  const revenue =
    finite(row.revenue);

  const ebitda =
    finite(row.ebitda);

  const netIncome =
    finite(row.net_income);

  const totalAssets =
    finite(row.total_assets);

  const totalEquity =
    finite(row.total_equity);

  const currentAssets =
    finite(row.current_assets);

  const currentLiabilities =
    finite(
      row.current_liabilities
    );

  const totalDebt =
    finite(row.total_debt);

  const cash =
    finite(row.cash);

  const ocf =
    finite(
      row.operating_cash_flow
    );

  const capex =
    finite(row.capex);

  const receivables =
    finite(
      row.accounts_receivable
    );

  const averageEquity =
    prior
      ? average(
          prior.total_equity,
          totalEquity
        )
      : null;

  const averageAssets =
    prior
      ? average(
          prior.total_assets,
          totalAssets
        )
      : null;

  const ebitdaMargin =
    divide(
      ebitda,
      revenue
    );

  const netMargin =
    divide(
      netIncome,
      revenue
    );

  const roe =
    divide(
      netIncome,
      averageEquity
    );

  const roa =
    divide(
      netIncome,
      averageAssets
    );

  const currentRatio =
    divide(
      currentAssets,
      currentLiabilities
    );

  const netDebt =
    totalDebt != null &&
    cash != null
      ? totalDebt - cash
      : null;

  const fcf =
    ocf != null &&
    capex != null
      ? ocf - capex
      : null;

  const cashConversion =
    divide(
      ocf,
      netIncome
    );

  const receivableDays =
    receivables != null &&
    revenue != null &&
    revenue !== 0
      ? (
          receivables /
          revenue
        ) * 365
      : null;

  const debtEquity =
    divide(
      totalDebt,
      totalEquity
    );

  return {
    ebitdaMargin:
      ebitdaMargin == null
        ? null
        : ebitdaMargin * 100,

    netMargin:
      netMargin == null
        ? null
        : netMargin * 100,

    roe:
      roe == null
        ? null
        : roe * 100,

    roa:
      roa == null
        ? null
        : roa * 100,

    currentRatio,

    netDebt,

    fcf,

    cashConversion,

    receivableDays,

    debtEquity
  };
}


/* ============================================================
   7. API HELPER
   ============================================================ */

async function api(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      {
        credentials: "same-origin",
        ...options
      }
    );

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  let body;

  if (
    contentType.includes(
      "application/json"
    )
  ) {
    body =
      await response.json();
  } else {
    const text =
      await response.text();

    body = {
      error:
        text ||
        `HTTP ${response.status}`
    };
  }

  if (!response.ok) {
    const error =
      new Error(
        body?.error ||
        body?.message ||
        `Request failed with HTTP ${response.status}.`
      );

    error.status =
      response.status;

    error.body =
      body;

    throw error;
  }

  return body;
}


/* ============================================================
   8. SESSION
   ============================================================ */

async function checkSession() {
  try {
    const session =
      await api(
        "/api/session"
      );

    if (session?.ok) {
      state.session =
        session;

      enterApplication();

      return;
    }
  } catch (error) {
    console.warn(
      "Session check failed:",
      error
    );
  }

  showLogin();
}


function showLogin() {
  show(
    byId("loginGate")
  );

  hide(
    byId("app")
  );
}


function enterApplication() {
  hide(
    byId("loginGate")
  );

  show(
    byId("app")
  );

  const usageDownload =
    byId("usageDownload");

  if (usageDownload) {
    usageDownload.hidden =
      !state.session?.admin;
  }
}


async function login(event) {
  event.preventDefault();

  const name =
    String(
      byId("loginName")?.value ||
      ""
    ).trim();

  const password =
    String(
      byId("loginPassword")?.value ||
      ""
    );

  const errorBox =
    byId("loginError");

  hide(errorBox);

  try {
    const result =
      await api(
        "/api/login",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            name,
            password
          })
        }
      );

    state.session =
      result;

    enterApplication();
  } catch (error) {
    if (errorBox) {
      errorBox.textContent =
        error.message;

      show(errorBox);
    }
  }
}


async function logout() {
  try {
    await api(
      "/api/logout",
      {
        method: "POST"
      }
    );
  } catch (error) {
    console.warn(
      "Logout request failed:",
      error
    );
  }

  state.session = null;
  state.company = null;
  state.financials = [];
  state.uploadedFile = null;
  state.reportAnalysis = null;

  showLogin();
}


/* ============================================================
   9. PDF UPLOAD
   ============================================================ */

async function uploadReport(event) {
  const file =
    event.target.files?.[0];

  if (!file) {
    return;
  }

  if (
    !/\.pdf$/i.test(file.name) &&
    file.type !== "application/pdf"
  ) {
    showError(
      "Please choose a valid annual-report PDF."
    );

    return;
  }

  state.uploadedFile =
    file;

  state.reportAnalysis =
    null;

  const status =
    byId("uploadStatus");

  const errorBox =
    byId("error");

  hide(errorBox);

  if (status) {
    status.textContent =
      "Extracting annual-report financials…";
  }

  const formData =
    new FormData();

  formData.append(
    "report",
    file
  );

  try {
    const result =
      await api(
        "/api/ai/extract-financials",
        {
          method: "POST",
          body: formData
        }
      );

    const normalized =
      normalizeExtraction(result);

    state.company =
      normalized.company;

    state.financials =
      normalized.financials;

    state.selectedYear =
      yearNumber(
        latestRow()
      );

    renderDashboard();

    if (status) {
      status.textContent =
        `${state.company?.name || "Company"}: ` +
        `${state.financials.length} reporting ` +
        `${state.financials.length === 1 ? "year" : "years"} ` +
        "extracted successfully.";
    }

    show(
      byId("companyWorkspace")
    );
  } catch (error) {
    console.error(
      "Financial extraction failed:",
      error
    );

    if (status) {
      status.textContent =
        "Financial extraction failed.";
    }

    showError(
      error.message ||
      "The annual report could not be extracted."
    );
  }
}


function showError(message) {
  const errorBox =
    byId("error");

  if (!errorBox) {
    return;
  }

  errorBox.textContent =
    message;

  show(errorBox);
}


/* ============================================================
   10. MAIN RENDER
   ============================================================ */

function renderDashboard() {
  renderCompanyHeader();
  renderYearControls();
  renderMetrics();
  renderFinancialHistory();
  renderPerformanceChart();
  renderHealthScore();
  renderSignals();
  renderResearchTabs();
}


/* ============================================================
   11. COMPANY HEADER
   ============================================================ */

function renderCompanyHeader() {
  const company =
    state.company || {};

  const rows =
    state.financials;

  setText(
    byId("companyName"),
    company.name ||
    company.legal_name ||
    "Unknown company"
  );

  const first =
    rows[0];

  const last =
    rows[
      rows.length - 1
    ];

  const basis =
    last?.statement_basis ||
    "Consolidated";

  const confidence =
    company.extraction_confidence ||
    "Gemini extracted";

  const range =
    first && last
      ? (
          first === last
            ? yearLabel(last)
            : `${yearLabel(first)} → ${yearLabel(last)}`
        )
      : "N/A";

  setText(
    byId("companyMeta"),
    `${range} · ${basis} financials · ${confidence}`
  );
}


/* ============================================================
   12. YEAR CONTROLS
   ============================================================ */

function renderYearControls() {
  const container =
    byId("yearControls");

  if (!container) {
    return;
  }

  container.innerHTML = "";

  if (!state.financials.length) {
    hide(container);
    return;
  }

  const allButton =
    document.createElement(
      "button"
    );

  allButton.type =
    "button";

  allButton.textContent =
    "Latest";

  allButton.className =
    state.selectedYear ===
    yearNumber(latestRow())
      ? "active"
      : "";

  allButton.addEventListener(
    "click",
    () => {
      state.selectedYear =
        yearNumber(
          latestRow()
        );

      renderDashboard();
    }
  );

  container.appendChild(
    allButton
  );

  [...state.financials]
    .reverse()
    .forEach(row => {
      const year =
        yearNumber(row);

      const button =
        document.createElement(
          "button"
        );

      button.type =
        "button";

      button.textContent =
        yearLabel(row);

      if (
        year ===
        state.selectedYear
      ) {
        button.classList.add(
          "active"
        );
      }

      button.addEventListener(
        "click",
        () => {
          state.selectedYear =
            year;

          renderDashboard();
        }
      );

      container.appendChild(
        button
      );
    });

  show(container);
}


/* ============================================================
   13. METRIC CARDS
   ============================================================ */

function metricCard(
  label,
  value,
  note
) {
  return `
    <article class="metric">
      <div class="metric-label">
        ${escapeHTML(label)}
      </div>

      <div class="metric-value">
        ${escapeHTML(value)}
      </div>

      <div class="metric-note">
        ${escapeHTML(note)}
      </div>
    </article>
  `;
}


function renderMetrics() {
  const container =
    byId("metrics");

  if (!container) {
    return;
  }

  const row =
    selectedRow();

  if (!row) {
    container.innerHTML = "";
    return;
  }

  const metrics =
    calculatedMetrics(row);

  setText(
    byId("snapshotTitle"),
    `${yearLabel(row)} snapshot`
  );

  const cards = [
    [
      "Revenue",
      money(row.revenue),
      "Reported revenue"
    ],

    [
      "EBITDA",
      money(row.ebitda),
      "Reported EBITDA"
    ],

    [
      "Net profit",
      money(row.net_income),
      "Reported net income"
    ],

    [
      "EBITDA margin",
      percent(
        metrics.ebitdaMargin
      ),
      "EBITDA / Revenue"
    ],

    [
      "Net margin",
      percent(
        metrics.netMargin
      ),
      "Net income / Revenue"
    ],

    [
      "ROE",
      percent(metrics.roe),
      "Net income / Average equity"
    ],

    [
      "ROA",
      percent(metrics.roa),
      "Net income / Average assets"
    ],

    [
      "Current ratio",
      multiple(
        metrics.currentRatio
      ),
      "Current assets / Current liabilities"
    ],

    [
      "Net debt",
      money(metrics.netDebt),
      "Debt − Cash"
    ],

    [
      "Simplified FCF",
      money(metrics.fcf),
      "OCF − Capex"
    ],

    [
      "Cash conversion",
      multiple(
        metrics.cashConversion
      ),
      "OCF / Net income"
    ],

    [
      "Receivable days",
      days(
        metrics.receivableDays
      ),
      "Receivables / Revenue × 365"
    ]
  ];

  container.innerHTML =
    cards
      .map(card =>
        metricCard(...card)
      )
      .join("");
}


/* ============================================================
   14. FINANCIAL HISTORY
   ============================================================ */

function renderFinancialHistory() {
  const head =
    byId(
      "financialHistoryHead"
    );

  const body =
    byId(
      "financialHistoryBody"
    );

  if (!head || !body) {
    return;
  }

  head.innerHTML =
    "<th>Metric</th>";

  state.financials.forEach(
    row => {
      head.insertAdjacentHTML(
        "beforeend",
        `<th>${escapeHTML(yearLabel(row))}</th>`
      );
    }
  );

  const rows = [
    {
      label: "Revenue",
      value: row =>
        money(row.revenue)
    },

    {
      label: "EBITDA",
      value: row =>
        money(row.ebitda)
    },

    {
      label: "Net profit",
      value: row =>
        money(row.net_income)
    },

    {
      label: "EBITDA margin",
      value: row =>
        percent(
          calculatedMetrics(row)
            .ebitdaMargin
        )
    },

    {
      label: "Net margin",
      value: row =>
        percent(
          calculatedMetrics(row)
            .netMargin
        )
    },

    {
      label: "ROE",
      value: row =>
        percent(
          calculatedMetrics(row)
            .roe
        )
    },

    {
      label: "ROA",
      value: row =>
        percent(
          calculatedMetrics(row)
            .roa
        )
    },

    {
      label: "Current ratio",
      value: row =>
        multiple(
          calculatedMetrics(row)
            .currentRatio
        )
    },

    {
      label: "Total assets",
      value: row =>
        money(row.total_assets)
    },

    {
      label: "Total equity",
      value: row =>
        money(row.total_equity)
    },

    {
      label: "Total debt",
      value: row =>
        money(row.total_debt)
    },

    {
      label: "Cash",
      value: row =>
        money(row.cash)
    },

    {
      label: "Net debt",
      value: row =>
        money(
          calculatedMetrics(row)
            .netDebt
        )
    },

    {
      label: "Operating cash flow",
      value: row =>
        money(
          row.operating_cash_flow
        )
    },

    {
      label: "Capex",
      value: row =>
        money(row.capex)
    },

    {
      label: "Simplified FCF",
      value: row =>
        money(
          calculatedMetrics(row)
            .fcf
        )
    },

    {
      label: "Cash conversion",
      value: row =>
        multiple(
          calculatedMetrics(row)
            .cashConversion
        )
    },

    {
      label: "Receivable days",
      value: row =>
        days(
          calculatedMetrics(row)
            .receivableDays
        )
    }
  ];

  body.innerHTML =
    rows
      .map(metric => {
        const values =
          state.financials
            .map(
              row =>
                `<td>${escapeHTML(metric.value(row))}</td>`
            )
            .join("");

        return `
          <tr>
            <td>${escapeHTML(metric.label)}</td>
            ${values}
          </tr>
        `;
      })
      .join("");
}


/* ============================================================
   15. PERFORMANCE CHART
   ============================================================ */

function renderPerformanceChart() {
  const canvas =
    byId("performanceChart");

  if (!canvas) {
    return;
  }

  /*
   * This dashboard intentionally avoids requiring
   * an external chart library.
   */

  const width =
    Math.max(
      canvas.clientWidth || 800,
      320
    );

  const height =
    Math.max(
      canvas.clientHeight || 400,
      300
    );

  const dpr =
    window.devicePixelRatio || 1;

  canvas.width =
    width * dpr;

  canvas.height =
    height * dpr;

  const ctx =
    canvas.getContext("2d");

  if (!ctx) {
    return;
  }

  ctx.scale(dpr, dpr);

  ctx.clearRect(
    0,
    0,
    width,
    height
  );

  const rows =
    state.financials;

  if (!rows.length) {
    return;
  }

  const series = [
    {
      label: "Revenue",
      values:
        rows.map(
          row =>
            finite(row.revenue)
        )
    },

    {
      label: "EBITDA",
      values:
        rows.map(
          row =>
            finite(row.ebitda)
        )
    },

    {
      label: "Net profit",
      values:
        rows.map(
          row =>
            finite(row.net_income)
        )
    }
  ];

  const allValues =
    series
      .flatMap(
        item =>
          item.values
      )
      .filter(
        value =>
          value != null
      );

  if (!allValues.length) {
    ctx.fillStyle =
      "#74877f";

    ctx.font =
      "14px sans-serif";

    ctx.fillText(
      "No chart data available.",
      20,
      40
    );

    return;
  }

  const maximum =
    Math.max(...allValues);

  const left = 60;
  const right = 25;
  const top = 30;
  const bottom = 60;

  const chartWidth =
    width - left - right;

  const chartHeight =
    height - top - bottom;

  ctx.strokeStyle =
    "#e1e8e4";

  ctx.lineWidth = 1;

  for (
    let i = 0;
    i <= 4;
    i += 1
  ) {
    const y =
      top +
      chartHeight *
      (i / 4);

    ctx.beginPath();

    ctx.moveTo(
      left,
      y
    );

    ctx.lineTo(
      width - right,
      y
    );

    ctx.stroke();
  }

  const palette = [
    "#2e856d",
    "#7f9951",
    "#123e34"
  ];

  const xForIndex =
    index => {
      if (rows.length === 1) {
        return (
          left +
          chartWidth / 2
        );
      }

      return (
        left +
        (
          index /
          (rows.length - 1)
        ) *
        chartWidth
      );
    };

  const yForValue =
    value =>
      top +
      chartHeight -
      (
        value /
        maximum
      ) *
      chartHeight;

  series.forEach(
    (item, seriesIndex) => {
      ctx.strokeStyle =
        palette[seriesIndex];

      ctx.fillStyle =
        palette[seriesIndex];

      ctx.lineWidth = 3;

      ctx.beginPath();

      let started = false;

      item.values.forEach(
        (value, index) => {
          if (value == null) {
            return;
          }

          const x =
            xForIndex(index);

          const y =
            yForValue(value);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      );

      ctx.stroke();

      item.values.forEach(
        (value, index) => {
          if (value == null) {
            return;
          }

          const x =
            xForIndex(index);

          const y =
            yForValue(value);

          ctx.beginPath();

          ctx.arc(
            x,
            y,
            4,
            0,
            Math.PI * 2
          );

          ctx.fill();
        }
      );
    }
  );

  ctx.font =
    "12px sans-serif";

  ctx.fillStyle =
    "#74877f";

  ctx.textAlign =
    "center";

  rows.forEach(
    (row, index) => {
      ctx.fillText(
        yearLabel(row),
        xForIndex(index),
        height - 25
      );
    }
  );

  ctx.textAlign =
    "left";

  series.forEach(
    (item, index) => {
      const x =
        left +
        index * 120;

      const y =
        height - 5;

      ctx.fillStyle =
        palette[index];

      ctx.fillRect(
        x,
        y - 8,
        22,
        3
      );

      ctx.fillStyle =
        "#61766e";

      ctx.fillText(
        item.label,
        x + 30,
        y
      );
    }
  );
}


/* ============================================================
   16. HEALTH SCORE
   ============================================================ */

function scoreMetric(
  value,
  ranges
) {
  const number =
    finite(value);

  if (number == null) {
    return null;
  }

  for (
    const range of ranges
  ) {
    if (
      range.test(number)
    ) {
      return range.score;
    }
  }

  return null;
}


function renderHealthScore() {
  const row =
    selectedRow();

  if (!row) {
    return;
  }

  const metrics =
    calculatedMetrics(row);

  const profitability =
    scoreMetric(
      metrics.netMargin,
      [
        {
          test: x => x >= 20,
          score: 95
        },
        {
          test: x => x >= 15,
          score: 85
        },
        {
          test: x => x >= 10,
          score: 72
        },
        {
          test: x => x >= 5,
          score: 55
        },
        {
          test: () => true,
          score: 35
        }
      ]
    );

  const liquidity =
    scoreMetric(
      metrics.currentRatio,
      [
        {
          test: x => x >= 1.5,
          score: 90
        },
        {
          test: x => x >= 1.2,
          score: 78
        },
        {
          test: x => x >= 1,
          score: 60
        },
        {
          test: x => x >= 0.75,
          score: 45
        },
        {
          test: () => true,
          score: 25
        }
      ]
    );

  const leverage =
    scoreMetric(
      metrics.debtEquity,
      [
        {
          test: x => x <= 0.25,
          score: 95
        },
        {
          test: x => x <= 0.5,
          score: 82
        },
        {
          test: x => x <= 1,
          score: 65
        },
        {
          test: x => x <= 2,
          score: 45
        },
        {
          test: () => true,
          score: 25
        }
      ]
    );

  const cash =
    scoreMetric(
      metrics.cashConversion,
      [
        {
          test: x => x >= 1,
          score: 95
        },
        {
          test: x => x >= 0.8,
          score: 80
        },
        {
          test: x => x >= 0.6,
          score: 65
        },
        {
          test: x => x >= 0.4,
          score: 45
        },
        {
          test: () => true,
          score: 25
        }
      ]
    );

  const efficiency =
    scoreMetric(
      metrics.receivableDays,
      [
        {
          test: x => x <= 30,
          score: 95
        },
        {
          test: x => x <= 60,
          score: 80
        },
        {
          test: x => x <= 90,
          score: 65
        },
        {
          test: x => x <= 120,
          score: 45
        },
        {
          test: () => true,
          score: 25
        }
      ]
    );

  const categories = [
    {
      label: "Profitability",
      score: profitability
    },

    {
      label: "Liquidity",
      score: liquidity
    },

    {
      label: "Leverage",
      score: leverage
    },

    {
      label: "CFO / net profit",
      score: cash
    },

    {
      label: "Efficiency",
      score: efficiency
    }
  ].filter(
    item =>
      item.score != null
  );

  const overall =
    categories.length
      ? Math.round(
          categories.reduce(
            (sum, item) =>
              sum + item.score,
            0
          ) /
          categories.length
        )
      : null;

  setText(
    byId("scoreValue"),
    overall ?? "N/A"
  );

  let label =
    "Insufficient financial data";

  if (overall != null) {
    if (overall >= 80) {
      label =
        "Strong financial profile";
    } else if (overall >= 65) {
      label =
        "Good financial profile";
    } else if (overall >= 50) {
      label =
        "Mixed financial profile";
    } else {
      label =
        "Financial profile needs attention";
    }
  }

  setText(
    byId("scoreLabel"),
    label
  );

  const bars =
    byId("scoreBars");

  if (!bars) {
    return;
  }

  if (!categories.length) {
    bars.innerHTML =
      `<p class="status-message">
        Insufficient extracted data to calculate the financial-health categories.
      </p>`;

    return;
  }

  bars.innerHTML =
    categories
      .map(
        item => `
          <div class="score-row">

            <div class="score-row-label">
              ${escapeHTML(item.label)}
            </div>

            <div class="score-track">
              <div
                class="score-fill"
                style="width:${Math.max(0, Math.min(100, item.score))}%"
              ></div>
            </div>

            <div class="score-number">
              ${escapeHTML(item.score)}
            </div>

          </div>
        `
      )
      .join("");
}


/* ============================================================
   17. INVESTOR SIGNALS
   ============================================================ */

function signal(
  title,
  explanation
) {
  return {
    title,
    explanation
  };
}


function renderSignalList(
  id,
  items
) {
  const container =
    byId(id);

  if (!container) {
    return;
  }

  if (!items.length) {
    container.innerHTML =
      `<div class="signal-item">
        <p>No supported signal available.</p>
      </div>`;

    return;
  }

  container.innerHTML =
    items
      .map(
        item => `
          <div class="signal-item">

            <strong>
              ${escapeHTML(item.title)}
            </strong>

            <p>
              ${escapeHTML(item.explanation)}
            </p>

          </div>
        `
      )
      .join("");
}


function renderSignals() {
  const row =
    selectedRow();

  if (!row) {
    return;
  }

  const prior =
    previousRow(row);

  const metrics =
    calculatedMetrics(row);

  const good = [];
  const bad = [];
  const watch = [];

  if (
    prior?.revenue != null &&
    row.revenue != null &&
    prior.revenue !== 0
  ) {
    const growth =
      (
        (
          row.revenue -
          prior.revenue
        ) /
        Math.abs(
          prior.revenue
        )
      ) * 100;

    if (growth >= 10) {
      good.push(
        signal(
          "Revenue momentum",
          `Revenue increased ${formatNumber(growth, 1)}% year-on-year.`
        )
      );
    } else if (growth < 0) {
      bad.push(
        signal(
          "Revenue contraction",
          `Revenue declined ${formatNumber(Math.abs(growth), 1)}% year-on-year.`
        )
      );
    } else {
      watch.push(
        signal(
          "Revenue growth",
          `Revenue increased ${formatNumber(growth, 1)}% year-on-year.`
        )
      );
    }
  }

  if (
    metrics.ebitdaMargin != null
  ) {
    if (
      metrics.ebitdaMargin >= 20
    ) {
      good.push(
        signal(
          "EBITDA margin",
          `EBITDA margin is ${percent(metrics.ebitdaMargin)}.`
        )
      );
    } else if (
      metrics.ebitdaMargin < 10
    ) {
      watch.push(
        signal(
          "EBITDA margin",
          `EBITDA margin is ${percent(metrics.ebitdaMargin)}.`
        )
      );
    }
  }

  if (
    metrics.cashConversion != null
  ) {
    if (
      metrics.cashConversion >= 0.8
    ) {
      good.push(
        signal(
          "Earnings cash conversion",
          `Operating cash flow is ${multiple(metrics.cashConversion)} reported net income.`
        )
      );
    } else {
      watch.push(
        signal(
          "Earnings cash conversion",
          `Operating cash flow is ${multiple(metrics.cashConversion)} reported net income.`
        )
      );
    }
  }

  if (
    metrics.debtEquity != null
  ) {
    if (
      metrics.debtEquity <= 0.5
    ) {
      good.push(
        signal(
          "Balance-sheet leverage",
          `Debt/equity is ${multiple(metrics.debtEquity)}.`
        )
      );
    } else if (
      metrics.debtEquity > 1.5
    ) {
      bad.push(
        signal(
          "Balance-sheet leverage",
          `Debt/equity is ${multiple(metrics.debtEquity)}.`
        )
      );
    } else {
      watch.push(
        signal(
          "Balance-sheet leverage",
          `Debt/equity is ${multiple(metrics.debtEquity)}.`
        )
      );
    }
  }

  if (
    metrics.currentRatio != null
  ) {
    if (
      metrics.currentRatio < 1
    ) {
      bad.push(
        signal(
          "Liquidity",
          `Current ratio is ${multiple(metrics.currentRatio)}.`
        )
      );
    } else if (
      metrics.currentRatio < 1.25
    ) {
      watch.push(
        signal(
          "Liquidity",
          `Current ratio is ${multiple(metrics.currentRatio)}.`
        )
      );
    } else {
      good.push(
        signal(
          "Liquidity",
          `Current ratio is ${multiple(metrics.currentRatio)}.`
        )
      );
    }
  }

  if (
    metrics.roe != null
  ) {
    if (
      metrics.roe >= 15
    ) {
      good.push(
        signal(
          "Return on equity",
          `ROE is ${percent(metrics.roe)}.`
        )
      );
    } else if (
      metrics.roe < 8
    ) {
      bad.push(
        signal(
          "Return on equity",
          `ROE is ${percent(metrics.roe)}.`
        )
      );
    } else {
      watch.push(
        signal(
          "Return on equity",
          `ROE is ${percent(metrics.roe)}.`
        )
      );
    }
  }

  if (
    metrics.receivableDays != null
  ) {
    if (
      metrics.receivableDays <= 60
    ) {
      good.push(
        signal(
          "Receivables",
          `Estimated receivable days are ${formatNumber(metrics.receivableDays, 1)}.`
        )
      );
    } else if (
      metrics.receivableDays > 120
    ) {
      bad.push(
        signal(
          "Receivables",
          `Estimated receivable days are ${formatNumber(metrics.receivableDays, 1)}.`
        )
      );
    } else {
      watch.push(
        signal(
          "Receivables",
          `Estimated receivable days are ${formatNumber(metrics.receivableDays, 1)}.`
        )
      );
    }
  }

  renderSignalList(
    "goodList",
    good
  );

  renderSignalList(
    "badList",
    bad
  );

  renderSignalList(
    "watchList",
    watch
  );
}


/* ============================================================
   18. DEEP RESEARCH TABS
   ============================================================ */

const researchTabs = [
  {
    id: "financials",
    label: "Financials"
  },

  {
    id: "cash",
    label: "Cash & earnings"
  },

  {
    id: "workingCapital",
    label: "Working capital"
  },

  {
    id: "debt",
    label: "Debt"
  },

  {
    id: "returns",
    label: "Returns"
  },

  {
    id: "evidence",
    label: "Report evidence"
  },

  {
    id: "checklist",
    label: "Investor checklist"
  }
];


function renderResearchTabs() {
  const tabs =
    byId("sectionTabs");

  if (!tabs) {
    return;
  }

  tabs.innerHTML = "";

  researchTabs.forEach(
    tab => {
      const button =
        document.createElement(
          "button"
        );

      button.type =
        "button";

      button.textContent =
        tab.label;

      if (
        state.activeResearchTab ===
        tab.id
      ) {
        button.classList.add(
          "active"
        );
      }

      button.addEventListener(
        "click",
        () => {
          state.activeResearchTab =
            tab.id;

          renderResearchTabs();
        }
      );

      tabs.appendChild(
        button
      );
    }
  );

  renderResearchPanel();
}


function panelCard(
  title,
  value,
  description
) {
  return `
    <article class="panel-card">

      <h4>
        ${escapeHTML(title)}
      </h4>

      <strong>
        ${escapeHTML(value)}
      </strong>

      <p>
        ${escapeHTML(description)}
      </p>

    </article>
  `;
}


function renderResearchPanel() {
  const panel =
    byId("sectionPanel");

  const row =
    selectedRow();

  if (!panel || !row) {
    return;
  }

  const metrics =
    calculatedMetrics(row);

  let cards = [];

  switch (
    state.activeResearchTab
  ) {

    case "cash":

      cards = [
        [
          "Net profit",
          money(row.net_income),
          "Reported net income."
        ],

        [
          "Operating cash flow",
          money(
            row.operating_cash_flow
          ),
          "Reported operating cash flow."
        ],

        [
          "Capital expenditure",
          money(row.capex),
          "Reported or extracted capital expenditure."
        ],

        [
          "Simplified free cash flow",
          money(metrics.fcf),
          "Operating cash flow less capital expenditure."
        ],

        [
          "Cash conversion",
          multiple(
            metrics.cashConversion
          ),
          "Operating cash flow divided by net income."
        ]
      ];

      break;


    case "workingCapital":

      cards = [
        [
          "Current assets",
          money(
            row.current_assets
          ),
          "Reported current assets."
        ],

        [
          "Current liabilities",
          money(
            row.current_liabilities
          ),
          "Reported current liabilities."
        ],

        [
          "Current ratio",
          multiple(
            metrics.currentRatio
          ),
          "Current assets divided by current liabilities."
        ],

        [
          "Receivables",
          money(
            row.accounts_receivable
          ),
          "Reported trade/accounts receivables."
        ],

        [
          "Receivable days",
          days(
            metrics.receivableDays
          ),
          "Receivables divided by revenue multiplied by 365."
        ],

        [
          "Inventory",
          money(row.inventory),
          "Reported inventories."
        ]
      ];

      break;


    case "debt":

      cards = [
        [
          "Total debt",
          money(row.total_debt),
          "Reported or extracted borrowings."
        ],

        [
          "Cash",
          money(row.cash),
          "Cash and cash equivalents."
        ],

        [
          "Net debt",
          money(metrics.netDebt),
          "Total debt less cash."
        ],

        [
          "Debt / equity",
          multiple(
            metrics.debtEquity
          ),
          "Total debt divided by total equity."
        ],

        [
          "Finance cost",
          money(
            row.finance_cost
          ),
          "Reported finance cost."
        ]
      ];

      break;


    case "returns":

      cards = [
        [
          "ROE",
          percent(metrics.roe),
          "Net income divided by average equity."
        ],

        [
          "ROA",
          percent(metrics.roa),
          "Net income divided by average assets."
        ],

        [
          "Net margin",
          percent(
            metrics.netMargin
          ),
          "Net income divided by revenue."
        ],

        [
          "EBITDA margin",
          percent(
            metrics.ebitdaMargin
          ),
          "EBITDA divided by revenue."
        ]
      ];

      break;


    case "evidence":

      cards = [
        [
          "Source pages",
          row.source_pages?.length
            ? row.source_pages.join(", ")
            : "N/A",
          "Annual-report pages associated with the extracted financial row."
        ],

        [
          "Statement basis",
          row.statement_basis ||
          "N/A",
          "Financial-statement basis used for the selected year."
        ],

        [
          "Extraction notes",
          row.extraction_notes ||
          "No extraction note provided.",
          "Additional evidence or extraction qualification."
        ]
      ];

      break;


    case "checklist":

      cards = [
        [
          "Revenue available",
          row.revenue != null
            ? "Yes"
            : "No",
          "Whether revenue was reliably extracted."
        ],

        [
          "Balance sheet available",
          (
            row.total_assets != null &&
            row.total_equity != null
          )
            ? "Yes"
            : "Incomplete",
          "Checks total assets and equity."
        ],

        [
          "Liquidity data available",
          (
            row.current_assets != null &&
            row.current_liabilities != null
          )
            ? "Yes"
            : "Incomplete",
          "Checks current assets and liabilities."
        ],

        [
          "Cash-flow data available",
          row.operating_cash_flow != null
            ? "Yes"
            : "Incomplete",
          "Checks operating cash flow."
        ],

        [
          "Debt and cash available",
          (
            row.total_debt != null &&
            row.cash != null
          )
            ? "Yes"
            : "Incomplete",
          "Required to calculate net debt."
        ]
      ];

      break;


    case "financials":
    default:

      cards = [
        [
          "Revenue",
          money(row.revenue),
          "Reported revenue."
        ],

        [
          "EBITDA",
          money(row.ebitda),
          metrics.ebitdaMargin != null
            ? `${percent(metrics.ebitdaMargin)} EBITDA margin.`
            : "EBITDA margin unavailable."
        ],

        [
          "Net profit",
          money(row.net_income),
          metrics.netMargin != null
            ? `${percent(metrics.netMargin)} net margin.`
            : "Net margin unavailable."
        ],

        [
          "Total assets",
          money(
            row.total_assets
          ),
          "Reported balance-sheet assets."
        ],

        [
          "Total equity",
          money(
            row.total_equity
          ),
          "Reported shareholder equity."
        ],

        [
          "Total debt",
          money(row.total_debt),
          "Reported or extracted borrowings."
        ]
      ];
  }

  panel.innerHTML =
    cards
      .map(card =>
        panelCard(...card)
      )
      .join("");
}


/* ============================================================
   19. ANNUAL REPORT AI
   ============================================================ */

async function runAnnualReportAI() {
  if (!state.uploadedFile) {
    setText(
      byId("aiAnalysisStatus"),
      "Upload an annual report first."
    );

    return;
  }

  const button =
    byId("runAIAnalysis");

  const status =
    byId("aiAnalysisStatus");

  const resultBox =
    byId("aiAnalysisResult");

  button?.classList.add(
    "is-loading"
  );

  if (button) {
    button.disabled = true;
  }

  hide(resultBox);

  setText(
    status,
    "Analyzing annual-report evidence…"
  );

  const formData =
    new FormData();

  formData.append(
    "report",
    state.uploadedFile
  );

  formData.append(
    "metrics",
    JSON.stringify({
      company:
        state.company,

      financials:
        state.financials
    })
  );

  try {
    const result =
      await api(
        "/api/ai/analyze-report",
        {
          method: "POST",
          body: formData
        }
      );

    state.reportAnalysis =
      result.analysis ||
      result;

    renderAIAnalysis(
      state.reportAnalysis
    );

    setText(
      status,
      "Annual-report analysis complete."
    );
  } catch (error) {
    console.error(
      "Annual-report AI failed:",
      error
    );

    setText(
      status,
      error.message ||
      "Annual-report analysis failed."
    );
  } finally {
    button?.classList.remove(
      "is-loading"
    );

    if (button) {
      button.disabled = false;
    }
  }
}


function renderAIAnalysis(
  analysis
) {
  const box =
    byId("aiAnalysisResult");

  if (!box) {
    return;
  }

  const sections = [
    [
      "Overall view",
      analysis?.overall_view
    ],

    [
      "Business",
      analysis?.business_summary
    ],

    [
      "Financials",
      analysis?.financial_summary
    ],

    [
      "Cash flow",
      analysis?.cash_flow_summary
    ],

    [
      "Management",
      analysis?.management_assessment
    ],

    [
      "Governance",
      analysis?.governance_assessment
    ],

    [
      "Auditor",
      analysis?.auditor_assessment
    ]
  ].filter(
    item =>
      item[1]
  );

  const renderItems =
    (title, items) => {
      if (
        !Array.isArray(items) ||
        !items.length
      ) {
        return "";
      }

      return `
        <section>
          <h4>${escapeHTML(title)}</h4>

          <ul>
            ${items
              .map(item => {
                if (
                  typeof item ===
                  "string"
                ) {
                  return `<li>${escapeHTML(item)}</li>`;
                }

                return `
                  <li>
                    <strong>
                      ${escapeHTML(item?.title || "")}
                    </strong>

                    ${
                      item?.explanation
                        ? ` — ${escapeHTML(item.explanation)}`
                        : ""
                    }
                  </li>
                `;
              })
              .join("")}
          </ul>
        </section>
      `;
    };

  box.innerHTML =
    sections
      .map(
        ([title, content]) => `
          <section>
            <h4>
              ${escapeHTML(title)}
            </h4>

            <p>
              ${escapeHTML(content)}
            </p>
          </section>
        `
      )
      .join("") +

    renderItems(
      "Good",
      analysis?.good
    ) +

    renderItems(
      "Bad",
      analysis?.bad
    ) +

    renderItems(
      "Watch",
      analysis?.watch
    ) +

    renderItems(
      "Risks",
      analysis?.risks
    ) +

    renderItems(
      "Investor questions",
      analysis?.investor_questions
    );

  show(box);
}


/* ============================================================
   20. ASK FINSIGHT
   ============================================================ */

async function askFinSight(
  event
) {
  event.preventDefault();

  const question =
    String(
      byId("askQuestion")
        ?.value ||
      ""
    ).trim();

  if (!question) {
    return;
  }

  const button =
    byId("askButton");

  const status =
    byId("askStatus");

  const resultBox =
    byId("askResult");

  hide(resultBox);

  button?.classList.add(
    "is-loading"
  );

  if (button) {
    button.disabled = true;
  }

  setText(
    status,
    "Researching the annual-report evidence…"
  );

  try {
    const result =
      await api(
        "/api/ai/ask",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            question,

            company:
              state.company,

            financials:
              state.financials,

            reportAnalysis:
              state.reportAnalysis,

            pdfContext: ""
          })
        }
      );

    renderAskAnswer(
      result.answer ||
      result
    );

    setText(
      status,
      "Answer generated from available report evidence."
    );
  } catch (error) {
    console.error(
      "Ask FinSight failed:",
      error
    );

    setText(
      status,
      error.message ||
      "FinSight could not answer the question."
    );
  } finally {
    button?.classList.remove(
      "is-loading"
    );

    if (button) {
      button.disabled = false;
    }
  }
}


function renderAskAnswer(
  answer
) {
  const box =
    byId("askResult");

  if (!box) {
    return;
  }

  const evidence =
    Array.isArray(
      answer?.evidence
    )
      ? answer.evidence
      : [];

  const missing =
    Array.isArray(
      answer?.missing_information
    )
      ? answer.missing_information
      : [];

  box.innerHTML = `
    <section>

      <h4>
        Answer
      </h4>

      <p>
        ${escapeHTML(
          answer?.answer ||
          "No supported answer was returned."
        )}
      </p>

    </section>

    ${
      answer?.calculation
        ? `
          <section>
            <h4>Calculation</h4>

            <p>
              ${escapeHTML(
                typeof answer.calculation === "string"
                  ? answer.calculation
                  : JSON.stringify(answer.calculation)
              )}
            </p>
          </section>
        `
        : ""
    }

    ${
      evidence.length
        ? `
          <section>
            <h4>Evidence</h4>

            <ul>
              ${evidence
                .map(
                  item =>
                    `<li>${escapeHTML(
                      typeof item === "string"
                        ? item
                        : JSON.stringify(item)
                    )}</li>`
                )
                .join("")}
            </ul>
          </section>
        `
        : ""
    }

    ${
      missing.length
        ? `
          <section>
            <h4>Missing information</h4>

            <ul>
              ${missing
                .map(
                  item =>
                    `<li>${escapeHTML(item)}</li>`
                )
                .join("")}
            </ul>
          </section>
        `
        : ""
    }

    ${
      answer?.confidence
        ? `
          <p>
            <strong>Confidence:</strong>
            ${escapeHTML(answer.confidence)}
          </p>
        `
        : ""
    }
  `;

  show(box);
}


async function start() {
  console.log("Starting FinSight...");

  console.log(
    `Gemini configured: ${Boolean(GEMINI_API_KEY)}`
  );

  console.log(
    `Gemini model: ${GEMINI_MODEL}`
  );

  console.log(
    `Database configured: ${databaseEnabled}`
  );

  await initDatabase();

  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log("FinSight server started.");
      console.log(`Port: ${PORT}`);
      console.log("Financial extraction: enabled");

      console.log(
        "Usage logging: " +
          (databaseEnabled
            ? "PostgreSQL/Supabase"
            : "disabled")
      );
    }
  );
}

start().catch(error => {
  console.error(
    "FinSight startup failed:",
    error
  );

  process.exit(1);
});
