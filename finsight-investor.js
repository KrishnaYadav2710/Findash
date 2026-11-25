const $ = s => document.querySelector(s);
let rows = [], company = null;
const nf = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
const finite = v => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const money = v => finite(v) == null ? "N/A" : `₹${nf.format(v)} Cr`;
const pct = v => finite(v) == null ? "N/A" : `${nf.format(v * 100)}%`;
const mult = v => finite(v) == null ? "N/A" : `${nf.format(v)}×`;
const days = v => finite(v) == null ? "N/A" : `${nf.format(v)} days`;
const yearLabel = r => r.financial_year || (r.year ? `FY${r.year - 1}-${String(r.year).slice(-2)}` : "Unknown FY");
function showError(msg) { $("#error").textContent = msg; $("#error").hidden = false; }
function clearError() { $("#error").hidden = true; }

async function init() {
  try {
    const session = await fetch("/api/session").then(r => r.json());
    if (session.ok) enterApp(session.name); else $("#loginGate").hidden = false;
  } catch { $("#loginGate").hidden = false; }
}
function enterApp(name) { $("#loginGate").hidden = true; $("#app").hidden = false; $("#userLabel").textContent = name || "User"; checkHealth(); }
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("#loginError").hidden = true;
  const response = await fetch("/api/login", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ name:$("#loginName").value, password:$("#loginPassword").value }) });
  const result = await response.json();
  if (!response.ok) { $("#loginError").textContent = result.error || "Login failed."; $("#loginError").hidden = false; return; }
  enterApp(result.name);
});
$("#logoutButton").addEventListener("click", async () => { await fetch("/api/logout", {method:"POST"}); location.reload(); });
async function checkHealth() { try { const r = await fetch("/api/health").then(x=>x.json()); $("#aiStatus").textContent = r.aiConfigured ? `Gemini ready · ${r.model}` : "Gemini API key missing"; } catch { $("#aiStatus").textContent = "Backend unavailable"; } }

$("#companyFile").addEventListener("change", async e => { const file = e.target.files?.[0]; if (file) await extract(file); });
async function extract(file) {
  clearError(); $("#uploadStatus").textContent = `Sending ${file.name} to Gemini… This can take up to a few minutes.`;
  const form = new FormData(); form.append("report", file);
  try {
    const response = await fetch("/api/ai/extract-financials", { method:"POST", body:form });
    const text = await response.text(); let result; try { result = JSON.parse(text); } catch { throw new Error("Server returned an unreadable response."); }
    if (!response.ok) throw new Error(result.error || `Extraction failed (${response.status}).`);
    company = result.company; rows = Array.isArray(result.financials) ? result.financials : [];
    if (!rows.length) throw new Error("Gemini returned no usable financial years.");
    render(); $("#uploadStatus").textContent = `${company.name}: ${rows.length} reporting year${rows.length === 1 ? "" : "s"} extracted successfully with Gemini.`;
  } catch (err) { showError(err.message || "Gemini extraction failed."); $("#uploadStatus").textContent = "Extraction failed. Try again after checking Gemini quota/API key."; }
}
function card(label, value, note) { return `<article class="metric"><span>${label}</span><strong>${value}</strong><small class="neutral">${note}</small></article>`; }
function render() {
  $("#companyWorkspace").hidden = false;
  const latest = rows.at(-1), first = rows[0];
  $("#companyName").textContent = company?.name || "Uploaded company";
  $("#period").textContent = rows.length > 1 ? `${yearLabel(first)} → ${yearLabel(latest)}` : yearLabel(latest);
  $("#statementBasis").textContent = `${latest.statement_basis || "Unknown"} financials`;
  $("#confidence").textContent = company?.extraction_confidence || "Gemini extracted";
  $("#snapshotTitle").textContent = `${yearLabel(latest)} snapshot`;
  $("#metrics").innerHTML = [
    ["Revenue", money(latest.revenue), "Reported revenue"], ["EBITDA", money(latest.ebitda), "Reported EBITDA"],
    ["EBIT / operating profit", money(latest.operating_income), "Reported EBIT / operating profit"], ["Net profit", money(latest.net_income), "Reported net income"],
    ["EBITDA margin", pct(latest.ebitda_margin), "EBITDA / Revenue"], ["Operating margin", pct(latest.operating_margin), "EBIT / Revenue"],
    ["Net margin", pct(latest.net_margin), "Net income / Revenue"], ["ROE", pct(latest.roe), "Net income / Average equity"],
    ["ROA", pct(latest.roa), "Net income / Average assets"], ["ROCE", pct(latest.roce), "EBIT / Average capital employed"],
    ["Interest coverage", mult(latest.interest_coverage), "EBIT / Finance cost"], ["Current ratio", mult(latest.current_ratio), "Current assets / Current liabilities"],
    ["Net debt", money(latest.net_debt), "Debt − Cash"], ["Simplified FCF", money(latest.simplified_fcf), "OCF − Capex"],
    ["Cash conversion", mult(latest.cash_conversion), "OCF / Net income"], ["Receivable days", days(latest.receivable_days), "Receivables / Revenue × 365"]
  ].map(x=>card(...x)).join("");
  renderHistory(); renderFormulas();
}
function renderHistory() {
  $("#financialHistoryHead").innerHTML = `<tr><th>Metric</th>${rows.map(r=>`<th>${yearLabel(r)}</th>`).join("")}</tr>`;
  const metrics = [
    ["Revenue", r=>money(r.revenue)], ["EBITDA", r=>money(r.ebitda)], ["EBIT / operating profit", r=>money(r.operating_income)], ["Net profit", r=>money(r.net_income)],
    ["EBITDA margin", r=>pct(r.ebitda_margin)], ["Operating margin", r=>pct(r.operating_margin)], ["Net margin", r=>pct(r.net_margin)],
    ["ROE", r=>pct(r.roe)], ["ROA", r=>pct(r.roa)], ["ROCE", r=>pct(r.roce)], ["Interest coverage", r=>mult(r.interest_coverage)],
    ["Current ratio", r=>mult(r.current_ratio)], ["Total debt", r=>money(r.total_debt)], ["Cash", r=>money(r.cash)], ["Net debt", r=>money(r.net_debt)],
    ["Operating cash flow", r=>money(r.operating_cash_flow)], ["Capex", r=>money(r.capex)], ["Simplified FCF", r=>money(r.simplified_fcf)],
    ["Cash conversion", r=>mult(r.cash_conversion)], ["Receivable days", r=>days(r.receivable_days)]
  ];
  $("#financialHistoryBody").innerHTML = metrics.map(([name,fn])=>`<tr><td>${name}</td>${rows.map(r=>`<td>${fn(r)}</td>`).join("")}</tr>`).join("");
}
function renderFormulas() {
  const formulas = [
    ["EBITDA margin","EBITDA / Revenue"],["Operating margin","EBIT / Revenue"],["Net margin","Net income / Revenue"],["ROE","Net income / Average equity"],
    ["ROA","Net income / Average assets"],["ROCE","EBIT / Average capital employed"],["Interest coverage","EBIT / Finance cost"],["Current ratio","Current assets / Current liabilities"],
    ["Net debt","Debt − Cash"],["Simplified FCF","OCF − Capex"],["Cash conversion","OCF / Net income"],["Receivable days","Receivables / Revenue × 365"]
  ];
  $("#formulaCards").innerHTML = formulas.map(([a,b])=>`<article class="panel-card"><h4>${a}</h4><p>${b}</p></article>`).join("");
}
init();
