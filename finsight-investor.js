const $ = s => document.querySelector(s);
let rows = [], company = null;

const nf = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 1
});

const finite = v =>
  v === null ||
  v === undefined ||
  v === "" ||
  (typeof v === "string" &&
    /^(n\/a|na|null|-)$/i.test(v.trim())) ||
  !Number.isFinite(Number(v))
    ? null
    : Number(v);

const money = v =>
  finite(v) == null ? "N/A" : `₹${nf.format(v)} Cr`;

const pct = v =>
  finite(v) == null ? "N/A" : `${nf.format(v * 100)}%`;

const mult = v =>
  finite(v) == null ? "N/A" : `${nf.format(v)}×`;

const days = v =>
  finite(v) == null ? "N/A" : `${nf.format(v)} days`;

const yearLabel = r =>
  r.financial_year ||
  (r.year ? `FY${r.year - 1}-${String(r.year).slice(-2)}` : "Unknown FY");

function showError(message) {
  $("#error").textContent = message;
  $("#error").hidden = false;
  $("#error").classList.add("error-pulse");
}

function clearError() {
  $("#error").hidden = true;
  $("#error").classList.remove("error-pulse");
}

function divide(a, b) {
  return finite(a) == null ||
    finite(b) == null ||
    finite(b) === 0
      ? null
      : finite(a) / finite(b);
}

function calculateRows(input) {
  const ordered = [...input].sort(
    (a, b) => (Number(a.year) || 0) - (Number(b.year) || 0)
  );

  return ordered.map((r, i) => {
    const prior = ordered[i - 1] || null;

    const avg = (current, previous) =>
      finite(current) != null && finite(previous) != null
        ? (finite(current) + finite(previous)) / 2
        : null;

    const capital = x =>
      finite(x.total_equity) != null &&
      finite(x.total_debt) != null &&
      finite(x.cash) != null
        ? x.total_equity + x.total_debt - x.cash
        : finite(x.total_assets) != null &&
          finite(x.current_liabilities) != null
        ? x.total_assets - x.current_liabilities
        : null;

    const ce = capital(r);
    const priorCe = prior ? capital(prior) : null;

    const out = { ...r };

    out.net_debt =
      finite(r.total_debt) != null && finite(r.cash) != null
        ? finite(r.total_debt) - finite(r.cash)
        : null;

    out.ebitda_margin = divide(r.ebitda, r.revenue);
    out.operating_margin = divide(r.operating_income, r.revenue);
    out.net_margin = divide(r.net_income, r.revenue);

    out.roe = divide(
      r.net_income,
      avg(r.total_equity, prior?.total_equity)
    );

    out.roa = divide(
      r.net_income,
      avg(r.total_assets, prior?.total_assets)
    );

    out.roce = divide(
      r.operating_income,
      avg(ce, priorCe)
    );

    out.interest_coverage = divide(
      r.operating_income,
      r.finance_cost
    );

    out.current_ratio = divide(
      r.current_assets,
      r.current_liabilities
    );

    out.simplified_fcf =
      finite(r.operating_cash_flow) != null &&
      finite(r.capex) != null
        ? finite(r.operating_cash_flow) - finite(r.capex)
        : null;

    out.cash_conversion = divide(
      r.operating_cash_flow,
      r.net_income
    );

    const avgReceivables = avg(
      r.accounts_receivable,
      prior?.accounts_receivable
    );

    const receivables =
      avgReceivables ?? r.accounts_receivable;

    out.receivable_days =
      divide(receivables, r.revenue) == null
        ? null
        : divide(receivables, r.revenue) * 365;

    out.debt_equity = divide(
      r.total_debt,
      r.total_equity
    );

    out.revenue_growth =
      prior &&
      finite(prior.revenue) != null &&
      finite(r.revenue) != null &&
      finite(prior.revenue) !== 0
        ? (r.revenue - prior.revenue) / prior.revenue
        : null;

    return out;
  });
}

async function init() {
  try {
    const session = await fetch("/api/session").then(r => r.json());

    if (session.ok) {
      enterApp(session.name, session.admin);
    } else {
      $("#loginGate").hidden = false;

      requestAnimationFrame(() => {
        $("#loginGate").classList.add("is-visible");
      });
    }
  } catch {
    $("#loginGate").hidden = false;

    requestAnimationFrame(() => {
      $("#loginGate").classList.add("is-visible");
    });
  }
}

function enterApp(name, admin = false) {
  const gate = $("#loginGate");
  const app = $("#app");

  gate.classList.add("is-leaving");

  setTimeout(() => {
    gate.hidden = true;
    gate.classList.remove("is-leaving");
  }, 420);

  app.hidden = false;
  app.classList.add("is-entering");

  $(".admin-download").hidden = !admin;

  setTimeout(() => {
    app.classList.remove("is-entering");
  }, 850);
}

$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();

  $("#loginError").hidden = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: $("#loginName").value,
        password: $("#loginPassword").value
      })
    });

    let result;

    try {
      result = await response.json();
    } catch {
      result = {
        error: "The server returned an unreadable login response."
      };
    }

    if (!response.ok) {
      $("#loginError").textContent =
        result.error || "Login failed.";

      $("#loginError").hidden = false;
      return;
    }

    enterApp(result.name, result.admin);
  } catch {
    $("#loginError").textContent =
      "Unable to connect to the server. Please try again.";

    $("#loginError").hidden = false;
  }
});

$("#logoutButton").addEventListener("click", async () => {
  await fetch("/api/logout", {
    method: "POST"
  });

  location.reload();
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();

    $("#aiStatus").textContent = health.aiConfigured
      ? `Gemini ready · ${health.model}`
      : "Gemini API key missing";
  } catch {
    $("#aiStatus").textContent = "Backend unavailable";
  }
}

$("#companyFile").addEventListener("change", async event => {
  const file = event.target.files?.[0];

  if (file) {
    await extract(file);
  }
});

async function extract(file) {
  clearError();

  if (
    file.type !== "application/pdf" &&
    !file.name.toLowerCase().endsWith(".pdf")
  ) {
    showError("Please upload a valid annual-report PDF.");
    return;
  }

  if (file.size > 45 * 1024 * 1024) {
    showError("This PDF is larger than the 45 MB upload limit.");
    return;
  }

  $("#app").classList.remove("report-loaded");
  $("#uploadStatus").classList.add("is-loading");

  $("#uploadStatus").textContent =
    `Extracting ${file.name}… This can take up to a few minutes.`;

  const form = new FormData();
  form.append("report", file);

  try {
    const response = await fetch(
      "/api/ai/extract-financials",
      {
        method: "POST",
        body: form
      }
    );

    const text = await response.text();

    let result;

    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(
        "Server returned an unreadable response."
      );
    }

    if (!response.ok) {
      throw new Error(
        result.error ||
        `Extraction failed (${response.status}).`
      );
    }

    console.debug(
      "Frontend received financials:",
      result.financials
    );

    company = result.company;

    rows = calculateRows(
      Array.isArray(result.financials)
        ? result.financials
        : []
    );

    if (!rows.length) {
      throw new Error(
        "Gemini returned no usable financial years."
      );
    }

    render();

    $("#app").classList.add("report-loaded");
    $("#uploadStatus").classList.remove("is-loading");

    $("#uploadStatus").textContent =
      `${company.name}: ${rows.length} reporting year${
        rows.length === 1 ? "" : "s"
      } extracted successfully.`;

    $("#companyWorkspace").classList.add(
      "workspace-enter"
    );

    setTimeout(() => {
      $("#companyWorkspace").classList.remove(
        "workspace-enter"
      );
    }, 1000);

    setTimeout(() => {
      $("#companyWorkspace").scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }, 80);
  } catch (error) {
    $("#uploadStatus").classList.remove("is-loading");

    showError(
      error.message ||
      "The report could not be extracted. Please check the PDF and try again."
    );

    $("#uploadStatus").textContent =
      "Extraction failed. Please try again.";
  }
}

function card(label, value, note) {
  return `
    <article class="metric">
      <span>${label}</span>
      <strong>${value}</strong>
      <small class="neutral">${note}</small>
    </article>
  `;
}

function render() {
  $("#companyWorkspace").hidden = false;

  const latest = rows.at(-1);
  const first = rows[0];

  $("#companyName").textContent =
    company?.name || "Uploaded company";

  $("#period").textContent =
    rows.length > 1
      ? `${yearLabel(first)} → ${yearLabel(latest)}`
      : yearLabel(latest);

  $("#statementBasis").textContent =
    `${latest.statement_basis || "Unknown"} financials`;

  $("#confidence").textContent =
    company?.extraction_confidence ||
    "Gemini extracted";

  $("#snapshotTitle").textContent =
    `${yearLabel(latest)} snapshot`;

  $("#metrics").innerHTML = [
    [
      "Revenue",
      money(latest.revenue),
      "Reported revenue"
    ],
    [
      "EBITDA",
      money(latest.ebitda),
      "Reported EBITDA"
    ],
    [
      "EBIT / operating profit",
      money(latest.operating_income),
      latest.operating_income_derived
        ? "Derived operating profit"
        : "Reported EBIT / operating profit"
    ],
    [
      "Net profit",
      money(latest.net_income),
      "Reported net income"
    ],
    [
      "EBITDA margin",
      pct(latest.ebitda_margin),
      "EBITDA / Revenue"
    ],
    [
      "Operating margin",
      pct(latest.operating_margin),
      "EBIT / Revenue"
    ],
    [
      "Net margin",
      pct(latest.net_margin),
      "Net income / Revenue"
    ],
    [
      "ROE",
      pct(latest.roe),
      "Net income / Average equity"
    ],
    [
      "ROA",
      pct(latest.roa),
      "Net income / Average assets"
    ],
    [
      "ROCE",
      pct(latest.roce),
      "EBIT / Average capital employed"
    ],
    [
      "Interest coverage",
      mult(latest.interest_coverage),
      "EBIT / Finance cost"
    ],
    [
      "Current ratio",
      mult(latest.current_ratio),
      "Current assets / Current liabilities"
    ],
    [
      "Net debt",
      money(latest.net_debt),
      "Debt − Cash"
    ],
    [
      "Simplified FCF",
      money(latest.simplified_fcf),
      "OCF − Capex"
    ],
    [
      "Cash conversion",
      mult(latest.cash_conversion),
      "OCF / Net income"
    ],
    [
      "Receivable days",
      days(latest.receivable_days),
      "Receivables / Revenue × 365"
    ]
  ]
    .map(item => card(...item))
    .join("");

  renderHistory();
  renderFormulas();
}

function renderHistory() {
  $("#financialHistoryHead").innerHTML = `
    <tr>
      <th>Metric</th>
      ${rows.map(row => `<th>${yearLabel(row)}</th>`).join("")}
    </tr>
  `;

  const metrics = [
    ["Revenue", row => money(row.revenue)],
    ["EBITDA", row => money(row.ebitda)],
    [
      "EBIT / operating profit",
      row => money(row.operating_income)
    ],
    ["Net profit", row => money(row.net_income)],
    ["EBITDA margin", row => pct(row.ebitda_margin)],
    [
      "Operating margin",
      row => pct(row.operating_margin)
    ],
    ["Net margin", row => pct(row.net_margin)],
    ["ROE", row => pct(row.roe)],
    ["ROA", row => pct(row.roa)],
    ["ROCE", row => pct(row.roce)],
    [
      "Interest coverage",
      row => mult(row.interest_coverage)
    ],
    [
      "Current ratio",
      row => mult(row.current_ratio)
    ],
    ["Total debt", row => money(row.total_debt)],
    ["Cash", row => money(row.cash)],
    ["Net debt", row => money(row.net_debt)],
    [
      "Operating cash flow",
      row => money(row.operating_cash_flow)
    ],
    ["Capex", row => money(row.capex)],
    [
      "Simplified FCF",
      row => money(row.simplified_fcf)
    ],
    [
      "Cash conversion",
      row => mult(row.cash_conversion)
    ],
    [
      "Receivable days",
      row => days(row.receivable_days)
    ]
  ];

  $("#financialHistoryBody").innerHTML =
    metrics
      .map(([name, formatter]) => `
        <tr>
          <td>${name}</td>
          ${rows.map(row => `<td>${formatter(row)}</td>`).join("")}
        </tr>
      `)
      .join("");
}

function renderFormulas() {
  const formulas = [
    ["EBITDA margin", "EBITDA / Revenue"],
    ["Operating margin", "EBIT / Revenue"],
    ["Net margin", "Net income / Revenue"],
    ["ROE", "Net income / Average equity"],
    ["ROA", "Net income / Average assets"],
    [
      "ROCE",
      "EBIT / Average capital employed"
    ],
    [
      "Interest coverage",
      "EBIT / Finance cost"
    ],
    [
      "Current ratio",
      "Current assets / Current liabilities"
    ],
    ["Net debt", "Debt − Cash"],
    ["Simplified FCF", "OCF − Capex"],
    ["Cash conversion", "OCF / Net income"],
    [
      "Receivable days",
      "Receivables / Revenue × 365"
    ]
  ];

  $("#formulaCards").innerHTML =
    formulas
      .map(([title, formula]) => `
        <article class="panel-card">
          <h4>${title}</h4>
          <p>${formula}</p>
        </article>
      `)
      .join("");
}

init();

function calculatedRows() {
  return rows;
}

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}

function renderChart() {
  const data = calculatedRows();
  const element = $("#chart");

  if (!element || !data.length) {
    return;
  }

  const series = [
    {
      key: "revenue",
      color: "#2f7d68",
      name: "Revenue"
    },
    {
      key: "ebitda",
      color: "#879c57",
      name: "EBITDA"
    },
    {
      key: "net_income",
      color: "#17332d",
      name: "Net profit"
    }
  ];

  const values = data.flatMap(row =>
    series
      .map(item => finite(row[item.key]))
      .filter(value => value != null)
  );

  if (!values.length) {
    element.innerHTML =
      "<p>No comparable series available.</p>";
    return;
  }

  const width = 900;
  const height = 330;
  const left = 72;
  const right = 28;
  const top = 30;
  const bottom = 58;

  const max = Math.max(...values, 1) * 1.1;
  const min = Math.min(0, ...values);
  const range = max - min || 1;

  const x = index =>
    data.length === 1
      ? (left + width - right) / 2
      : left +
        index *
          (width - left - right) /
          (data.length - 1);

  const y = value =>
    top +
    ((max - value) / range) *
      (height - top - bottom);

  const grid = [0, .25, .5, .75, 1]
    .map(step => {
      const value = min + range * step;
      const position = y(value);

      return `
        <line
          x1="${left}"
          x2="${width - right}"
          y1="${position}"
          y2="${position}"
          stroke="rgba(22,49,43,.10)"
        />
        <text
          x="${left - 12}"
          y="${position + 4}"
          text-anchor="end"
          fill="#76847f"
          font-size="10"
        >
          ${new Intl.NumberFormat("en-IN", {
            notation: "compact",
            maximumFractionDigits: 1
          }).format(value)}
        </text>
      `;
    })
    .join("");

  const paths = series
    .map(item => {
      let path = "";
      let started = false;

      data.forEach((row, index) => {
        const value = finite(row[item.key]);

        if (value == null) {
          started = false;
          return;
        }

        path += `${started ? " L" : " M"}${x(index)} ${y(value)}`;
        started = true;
      });

      const dots = data
        .map((row, index) => {
          const value = finite(row[item.key]);

          if (value == null) {
            return "";
          }

          return `
            <circle
              cx="${x(index)}"
              cy="${y(value)}"
              r="4"
              fill="${item.color}"
            >
              <title>
                ${item.name} · ${yearLabel(row)} · ${money(value)}
              </title>
            </circle>
          `;
        })
        .join("");

      return `
        <path
          d="${path}"
          fill="none"
          stroke="${item.color}"
          stroke-width="3"
          stroke-linecap="round"
        />
        ${dots}
      `;
    })
    .join("");

  const labels = data
    .map((row, index) => `
      <text
        x="${x(index)}"
        y="${height - 18}"
        text-anchor="middle"
        fill="#52645f"
        font-size="11"
      >
        ${yearLabel(row)}
      </text>
    `)
    .join("");

  element.innerHTML = `
    <svg
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="Financial performance chart"
    >
      ${grid}
      ${paths}
      ${labels}
    </svg>
  `;
}

function buildScores(row) {
  const scores = {};
  const profitability = [];

  if (finite(row.operating_margin) != null) {
    profitability.push(
      clamp(30 + row.operating_margin * 200)
    );
  }

  if (finite(row.roe) != null) {
    profitability.push(
      clamp(30 + row.roe * 200)
    );
  }

  if (finite(row.roce) != null) {
    profitability.push(
      clamp(30 + row.roce * 200)
    );
  }

  if (profitability.length) {
    scores.Profitability =
      profitability.reduce((a, b) => a + b, 0) /
      profitability.length;
  }

  if (finite(row.current_ratio) != null) {
    scores.Liquidity =
      row.current_ratio < 1
        ? clamp(row.current_ratio * 45)
        : row.current_ratio < 1.5
        ? 55 + (row.current_ratio - 1) * 40
        : row.current_ratio <= 3
        ? 75 + (row.current_ratio - 1.5) * 10
        : 90;
  }

  if (finite(row.debt_equity) != null) {
    scores.Leverage =
      row.debt_equity <= .25
        ? 95
        : row.debt_equity <= .5
        ? 85
        : row.debt_equity <= 1
        ? 70
        : row.debt_equity <= 1.5
        ? 50
        : row.debt_equity <= 2
        ? 30
        : 15;
  }

  if (finite(row.cash_conversion) != null) {
    scores["CFO / net profit"] =
      row.cash_conversion <= 0
        ? 0
        : row.cash_conversion < .5
        ? 25
        : row.cash_conversion < .75
        ? 45
        : row.cash_conversion < 1
        ? 65
        : row.cash_conversion <= 1.5
        ? 90
        : 85;
  }

  if (finite(row.receivable_days) != null) {
    scores.Efficiency =
      row.receivable_days <= 30
        ? 95
        : row.receivable_days <= 60
        ? 80
        : row.receivable_days <= 90
        ? 60
        : row.receivable_days <= 120
        ? 40
        : 20;
  }

  return scores;
}

function renderScore() {
  const row = rows.at(-1);

  if (!row) {
    return;
  }

  const entries = Object.entries(buildScores(row))
    .filter(([, value]) => Number.isFinite(value));

  const total = entries.length
    ? Math.round(
        entries.reduce(
          (sum, [, value]) => sum + value,
          0
        ) / entries.length
      )
    : null;

  $("#ring").style.setProperty(
    "--score",
    total ?? 0
  );

  $("#score").textContent =
    total ?? "N/A";

  $("#scoreLabel").textContent =
    total == null
      ? "Insufficient financial data"
      : total >= 80
      ? "Strong financial profile"
      : total >= 65
      ? "Good financial profile"
      : total >= 50
      ? "Mixed financial profile"
      : "Elevated financial risk";

  $("#scoreCopy").textContent =
    total == null
      ? "Not enough extracted data to calculate the score."
      : `Heuristic score calculated from ${entries.length} available categories. Missing categories are excluded.`;

  $("#scoreBars").innerHTML =
    entries
      .map(([name, value]) => `
        <div class="score-row">
          <span>${name}</span>
          <div class="track">
            <i style="width:${Math.round(value)}%"></i>
          </div>
          <b>${Math.round(value)}</b>
        </div>
      `)
      .join("");
}

function renderSignals() {
  const row = rows.at(-1);

  if (!row) {
    return;
  }

  const signals = [];

  const add = (type, title, text) => {
    signals.push({
      type,
      title,
      text
    });
  };

  if (finite(row.revenue_growth) != null) {
    add(
      row.revenue_growth > .10
        ? "good"
        : row.revenue_growth >= 0
        ? "watch"
        : "bad",
      "Revenue momentum",
      `Revenue ${
        row.revenue_growth >= 0
          ? "grew"
          : "declined"
      } ${nf.format(
        Math.abs(row.revenue_growth) * 100
      )}% year-on-year.`
    );
  }

  if (finite(row.ebitda_margin) != null) {
    add(
      row.ebitda_margin >= .20
        ? "good"
        : row.ebitda_margin >= .10
        ? "watch"
        : "bad",
      "EBITDA margin",
      `EBITDA margin is ${pct(row.ebitda_margin)}.`
    );
  }

  if (finite(row.cash_conversion) != null) {
    add(
      row.cash_conversion >= 1
        ? "good"
        : row.cash_conversion >= .75
        ? "watch"
        : "bad",
      "Earnings cash conversion",
      `Operating cash flow is ${mult(
        row.cash_conversion
      )} reported net income.`
    );
  }

  if (finite(row.debt_equity) != null) {
    add(
      row.debt_equity <= .7
        ? "good"
        : row.debt_equity <= 1.5
        ? "watch"
        : "bad",
      "Balance-sheet leverage",
      `Debt/equity is ${mult(row.debt_equity)}.`
    );
  }

  if (finite(row.current_ratio) != null) {
    add(
      row.current_ratio >= 1.5
        ? "good"
        : row.current_ratio >= 1
        ? "watch"
        : "bad",
      "Liquidity",
      `Current ratio is ${mult(row.current_ratio)}.`
    );
  }

  if (finite(row.roe) != null) {
    add(
      row.roe >= .18
        ? "good"
        : row.roe >= .10
        ? "watch"
        : "bad",
      "Return on equity",
      `ROE is ${pct(row.roe)}.`
    );
  }

  if (finite(row.receivable_days) != null) {
    add(
      row.receivable_days <= 45
        ? "good"
        : row.receivable_days <= 75
        ? "watch"
        : "bad",
      "Receivables",
      `Estimated receivable days are ${nf.format(
        row.receivable_days
      )}.`
    );
  }

  ["good", "bad", "watch"].forEach(type => {
    $(`#${type}List`).innerHTML =
      signals
        .filter(signal => signal.type === type)
        .map(signal => `
          <div class="finding">
            <b>${signal.title}</b><br>
            ${signal.text}
          </div>
        `)
        .join("") ||
      `<div class="finding">
        No signal in this category from available fields.
      </div>`;
  });
}

const researchSections = [
  "Financials",
  "Cash & earnings",
  "Working capital",
  "Debt",
  "Returns"
];

function renderResearchTabs() {
  const container = $("#sectionTabs");

  if (!container) {
    return;
  }

  container.innerHTML =
    researchSections
      .map((name, index) => `
        <button
          type="button"
          class="tab ${index === 0 ? "active" : ""}"
          data-section="${name}"
        >
          ${name}
        </button>
      `)
      .join("");

  container
    .querySelectorAll(".tab")
    .forEach(button => {
      button.addEventListener("click", () => {
        container
          .querySelectorAll(".tab")
          .forEach(item => {
            item.classList.remove("active");
          });

        button.classList.add("active");
        renderResearchSection(button.dataset.section);
      });
    });

  renderResearchSection(researchSections[0]);
}

function renderResearchSection(name) {
  const row = rows.at(-1);

  if (!row) {
    return;
  }

  let cards = [];

  if (name === "Financials") {
    cards = [
      [
        "Revenue",
        money(row.revenue),
        "Reported revenue."
      ],
      [
        "EBITDA",
        money(row.ebitda),
        `${pct(row.ebitda_margin)} EBITDA margin.`
      ],
      [
        "EBIT / operating profit",
        money(row.operating_income),
        row.operating_income == null
          ? "Not reliably established."
          : `${pct(row.operating_margin)} operating margin.`
      ],
      [
        "Net profit",
        money(row.net_income),
        `${pct(row.net_margin)} net margin.`
      ],
      [
        "Total assets",
        money(row.total_assets),
        "Reported balance-sheet assets."
      ],
      [
        "Total equity",
        money(row.total_equity),
        "Reported shareholder equity."
      ]
    ];
  }

  if (name === "Cash & earnings") {
    cards = [
      [
        "Operating cash flow",
        money(row.operating_cash_flow),
        "Cash generated from operations."
      ],
      [
        "CFO / profit",
        mult(row.cash_conversion),
        "Operating cash flow relative to net profit."
      ],
      [
        "Capex",
        money(row.capex),
        "Extracted capital expenditure."
      ],
      [
        "Simplified FCF",
        money(row.simplified_fcf),
        "Operating cash flow less capex."
      ]
    ];
  }

  if (name === "Working capital") {
    cards = [
      [
        "Receivables",
        money(row.accounts_receivable),
        `${days(row.receivable_days)} estimated collection period.`
      ],
      [
        "Inventory",
        money(row.inventory),
        "Reported inventory where available."
      ],
      [
        "Payables",
        money(row.accounts_payable),
        "Reported trade payables where available."
      ],
      [
        "Current ratio",
        mult(row.current_ratio),
        "Current assets / current liabilities."
      ]
    ];
  }

  if (name === "Debt") {
    cards = [
      [
        "Total debt",
        money(row.total_debt),
        "Reported/extracted debt."
      ],
      [
        "Cash",
        money(row.cash),
        "Cash and cash equivalents."
      ],
      [
        "Net debt",
        money(row.net_debt),
        "Debt less cash."
      ],
      [
        "Debt / equity",
        mult(row.debt_equity),
        "Debt relative to equity."
      ],
      [
        "Finance cost",
        money(row.finance_cost),
        "Finance cost where available."
      ],
      [
        "Interest coverage",
        mult(row.interest_coverage),
        "EBIT / finance cost."
      ]
    ];
  }

  if (name === "Returns") {
    cards = [
      [
        "ROE",
        pct(row.roe),
        "Net income / average equity."
      ],
      [
        "ROA",
        pct(row.roa),
        "Net income / average assets."
      ],
      [
        "ROCE",
        pct(row.roce),
        "EBIT / average capital employed."
      ]
    ];
  }

  $("#sectionPanel").innerHTML = `
    <div class="panel-grid">
      ${cards
        .map(([heading, value, copy]) => `
          <article class="panel-card">
            <h4>${heading}</h4>
            <strong>${value}</strong>
            <p>${copy}</p>
          </article>
        `)
        .join("")}
    </div>
  `;
}

const originalRender = render;

render = function() {
  originalRender();
  renderChart();
  renderScore();
  renderSignals();
  renderResearchTabs();
};
