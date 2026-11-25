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
function enterApp(name) { $("#loginGate").hidden = true; $("#app").hidden = false; }
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
  clearError(); $("#uploadStatus").textContent = `Extracting ${file.name}… This can take up to a few minutes.`;
  const form = new FormData(); form.append("report", file);
  try {
    const response = await fetch("/api/ai/extract-financials", { method:"POST", body:form });
    const text = await response.text(); let result; try { result = JSON.parse(text); } catch { throw new Error("Server returned an unreadable response."); }
    if (!response.ok) throw new Error(result.error || `Extraction failed (${response.status}).`);
    company = result.company; rows = Array.isArray(result.financials) ? result.financials : [];
    if (!rows.length) throw new Error("Gemini returned no usable financial years.");
    render(); $("#uploadStatus").textContent = `${company.name}: ${rows.length} reporting year${rows.length === 1 ? "" : "s"} extracted successfully.`;
  } catch (err) { showError(err.message || "Financial extraction failed."); $("#uploadStatus").textContent = "Extraction failed. Please try again."; }
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
    ["EBIT / operating profit", money(latest.operating_income), latest.operating_income_derived ? "Derived: profit before tax + finance cost" : "Reported EBIT / operating profit"], ["Net profit", money(latest.net_income), "Reported net income"],
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

/* ============================================================
   ADDED DASHBOARD MODULES
   ============================================================ */
function calculatedRows(){ return rows; }
function clamp(v){ return Math.max(0,Math.min(100,v)); }
function renderChart(){
  const data=calculatedRows(), el=$("#chart"); if(!el||!data.length)return;
  const series=[{k:"revenue",c:"#2f7d68",n:"Revenue"},{k:"ebitda",c:"#879c57",n:"EBITDA"},{k:"net_income",c:"#17332d",n:"Net profit"}];
  const vals=data.flatMap(r=>series.map(s=>finite(r[s.k])).filter(v=>v!=null)); if(!vals.length){el.innerHTML="<p>No comparable series available.</p>";return;}
  const W=900,H=330,L=72,R=28,T=30,B=58,max=Math.max(...vals,1)*1.1,min=Math.min(0,...vals),range=max-min||1;
  const x=i=>data.length===1?(L+W-R)/2:L+i*(W-L-R)/(data.length-1), y=v=>T+(max-v)/range*(H-T-B);
  const grid=[0,.25,.5,.75,1].map(q=>{const v=min+range*q,py=y(v);return `<line x1="${L}" x2="${W-R}" y1="${py}" y2="${py}" stroke="rgba(22,49,43,.10)"/><text x="${L-12}" y="${py+4}" text-anchor="end" fill="#76847f" font-size="10">${new Intl.NumberFormat('en-IN',{notation:'compact',maximumFractionDigits:1}).format(v)}</text>`}).join('');
  const paths=series.map(s=>{let d='',started=false;data.forEach((r,i)=>{const v=finite(r[s.k]);if(v==null){started=false;return}d+=`${started?' L':' M'}${x(i)} ${y(v)}`;started=true});const dots=data.map((r,i)=>{const v=finite(r[s.k]);return v==null?'':`<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${s.c}"><title>${s.n} · ${yearLabel(r)} · ${money(v)}</title></circle>`}).join('');return `<path d="${d}" fill="none" stroke="${s.c}" stroke-width="3" stroke-linecap="round"/>${dots}`}).join('');
  const labels=data.map((r,i)=>`<text x="${x(i)}" y="${H-18}" text-anchor="middle" fill="#52645f" font-size="11">${yearLabel(r)}</text>`).join('');
  el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Financial performance chart">${grid}${paths}${labels}</svg>`;
}
function buildScores(r){const s={},p=[];if(finite(r.operating_margin)!=null)p.push(clamp(30+r.operating_margin*200));if(finite(r.roe)!=null)p.push(clamp(30+r.roe*200));if(finite(r.roce)!=null)p.push(clamp(30+r.roce*200));if(p.length)s.Profitability=p.reduce((a,b)=>a+b,0)/p.length;if(finite(r.current_ratio)!=null)s.Liquidity=r.current_ratio<1?clamp(r.current_ratio*45):r.current_ratio<1.5?55+(r.current_ratio-1)*40:r.current_ratio<=3?75+(r.current_ratio-1.5)*10:90;if(finite(r.debt_equity)!=null)s.Leverage=r.debt_equity<=.25?95:r.debt_equity<=.5?85:r.debt_equity<=1?70:r.debt_equity<=1.5?50:r.debt_equity<=2?30:15;if(finite(r.cash_conversion)!=null)s["CFO / net profit"]=r.cash_conversion<=0?0:r.cash_conversion<.5?25:r.cash_conversion<.75?45:r.cash_conversion<1?65:r.cash_conversion<=1.5?90:85;if(finite(r.receivable_days)!=null)s.Efficiency=r.receivable_days<=30?95:r.receivable_days<=60?80:r.receivable_days<=90?60:r.receivable_days<=120?40:20;return s}
function renderScore(){const r=rows.at(-1);if(!r)return;const entries=Object.entries(buildScores(r)).filter(([,v])=>Number.isFinite(v)),total=entries.length?Math.round(entries.reduce((a,[,v])=>a+v,0)/entries.length):null;$("#ring").style.setProperty("--score",total??0);$("#score").textContent=total??"N/A";$("#scoreLabel").textContent=total==null?"Insufficient financial data":total>=80?"Strong financial profile":total>=65?"Good financial profile":total>=50?"Mixed financial profile":"Elevated financial risk";$("#scoreCopy").textContent=total==null?"Not enough extracted data to calculate the score.":`Heuristic score calculated from ${entries.length} available categories. Missing categories are excluded.`;$("#scoreBars").innerHTML=entries.map(([n,v])=>`<div class="score-row"><span>${n}</span><div class="track"><i style="width:${Math.round(v)}%"></i></div><b>${Math.round(v)}</b></div>`).join('')}
function renderSignals(){const r=rows.at(-1);if(!r)return;const sig=[];const add=(type,title,text)=>sig.push({type,title,text});if(finite(r.revenue_growth)!=null)add(r.revenue_growth>.10?'good':r.revenue_growth>=0?'watch':'bad','Revenue momentum',`Revenue ${r.revenue_growth>=0?'grew':'declined'} ${nf.format(Math.abs(r.revenue_growth)*100)}% year-on-year.`);if(finite(r.ebitda_margin)!=null)add(r.ebitda_margin>=.20?'good':r.ebitda_margin>=.10?'watch':'bad','EBITDA margin',`EBITDA margin is ${pct(r.ebitda_margin)}.`);if(finite(r.cash_conversion)!=null)add(r.cash_conversion>=1?'good':r.cash_conversion>=.75?'watch':'bad','Earnings cash conversion',`Operating cash flow is ${mult(r.cash_conversion)} reported net income.`);if(finite(r.debt_equity)!=null)add(r.debt_equity<=.7?'good':r.debt_equity<=1.5?'watch':'bad','Balance-sheet leverage',`Debt/equity is ${mult(r.debt_equity)}.`);if(finite(r.current_ratio)!=null)add(r.current_ratio>=1.5?'good':r.current_ratio>=1?'watch':'bad','Liquidity',`Current ratio is ${mult(r.current_ratio)}.`);if(finite(r.roe)!=null)add(r.roe>=.18?'good':r.roe>=.10?'watch':'bad','Return on equity',`ROE is ${pct(r.roe)}.`);if(finite(r.receivable_days)!=null)add(r.receivable_days<=45?'good':r.receivable_days<=75?'watch':'bad','Receivables',`Estimated receivable days are ${nf.format(r.receivable_days)}.`);['good','bad','watch'].forEach(t=>{$(`#${t}List`).innerHTML=sig.filter(x=>x.type===t).map(x=>`<div class="finding"><b>${x.title}</b><br>${x.text}</div>`).join('')||'<div class="finding">No signal in this category from available fields.</div>'})}
const researchSections=['Financials','Cash & earnings','Working capital','Debt','Returns'];
function renderResearchTabs(){const c=$("#sectionTabs");if(!c)return;c.innerHTML=researchSections.map((n,i)=>`<button type="button" class="tab ${i===0?'active':''}" data-section="${n}">${n}</button>`).join('');c.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{c.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderResearchSection(b.dataset.section)}));renderResearchSection(researchSections[0])}
function renderResearchSection(name){const r=rows.at(-1);if(!r)return;let a=[];if(name==='Financials')a=[['Revenue',money(r.revenue),'Reported revenue.'],['EBITDA',money(r.ebitda),`${pct(r.ebitda_margin)} EBITDA margin.`],['EBIT / operating profit',money(r.operating_income),r.operating_income==null?'Not reliably established.':`${pct(r.operating_margin)} operating margin.`],['Net profit',money(r.net_income),`${pct(r.net_margin)} net margin.`],['Total assets',money(r.total_assets),'Reported balance-sheet assets.'],['Total equity',money(r.total_equity),'Reported shareholder equity.']];if(name==='Cash & earnings')a=[['Operating cash flow',money(r.operating_cash_flow),'Cash generated from operations.'],['CFO / profit',mult(r.cash_conversion),'Operating cash flow relative to net profit.'],['Capex',money(r.capex),'Extracted capital expenditure.'],['Simplified FCF',money(r.simplified_fcf),'Operating cash flow less capex.']];if(name==='Working capital')a=[['Receivables',money(r.accounts_receivable),`${days(r.receivable_days)} estimated collection period.`],['Inventory',money(r.inventory),'Reported inventory where available.'],['Payables',money(r.accounts_payable),'Reported trade payables where available.'],['Current ratio',mult(r.current_ratio),'Current assets / current liabilities.']];if(name==='Debt')a=[['Total debt',money(r.total_debt),'Reported/extracted debt.'],['Cash',money(r.cash),'Cash and cash equivalents.'],['Net debt',money(r.net_debt),'Debt less cash.'],['Debt / equity',mult(r.debt_equity),'Debt relative to equity.'],['Finance cost',money(r.finance_cost),'Finance cost where available.'],['Interest coverage',mult(r.interest_coverage),'EBIT / finance cost.']];if(name==='Returns')a=[['ROE',pct(r.roe),'Net income / average equity.'],['ROA',pct(r.roa),'Net income / average assets.'],['ROCE',pct(r.roce),'EBIT / average capital employed.']];$("#sectionPanel").innerHTML=`<div class="panel-grid">${a.map(([h,v,c])=>`<article class="panel-card"><h4>${h}</h4><strong>${v}</strong><p>${c}</p></article>`).join('')}</div>`}
const originalRender=render;
render=function(){originalRender();renderChart();renderScore();renderSignals();renderResearchTabs();};
