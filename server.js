import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const ACCESS_PASSWORD = String(process.env.FINSIGHT_ACCESS_PASSWORD || "").trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || "change-me-in-render");
const USAGE_LOG_PATH = String(process.env.USAGE_LOG_PATH || path.join(__dirname, "finsight-usage.xlsx"));
const MAX_PDF_SIZE = 45 * 1024 * 1024;
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_SIZE } });
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

function safeText(value, max = 300) { return String(value || "").trim().slice(0, max); }
function finite(value) { const n = Number(value); return value === null || value === "" || !Number.isFinite(n) ? null : n; }
function round(value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : null; }
function ratio(a, b) { a = finite(a); b = finite(b); return a == null || b == null || b === 0 ? null : a / b; }
function diff(a, b) { a = finite(a); b = finite(b); return a == null || b == null ? null : a - b; }

function validatePdf(file) {
  if (!file?.buffer?.length) throw Object.assign(new Error("Upload an annual-report PDF."), { status: 400 });
  if (file.buffer.length > MAX_PDF_SIZE) throw Object.assign(new Error("PDF exceeds the 45 MB limit."), { status: 413 });
  if (file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw Object.assign(new Error("The uploaded file is not a valid PDF."), { status: 400 });
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(v => v.trim()).filter(Boolean).map(v => { const i = v.indexOf("="); return i < 0 ? [v, ""] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]; }));
}
function signSession(name, issuedAt) {
  const payload = Buffer.from(JSON.stringify({ name, issuedAt })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function readSession(req) {
  try {
    const token = parseCookies(req).finsight_session;
    if (!token) return null;
    const [payload, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.name || Date.now() - Number(data.issuedAt) > SESSION_MAX_AGE_MS) return null;
    return data;
  } catch { return null; }
}
function requireSession(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ ok: false, error: "Please enter FinSight first." });
  req.session = session;
  next();
}

async function appendUsage({ name, fileName = "", company = "", status = "Entered site" }) {
  fs.mkdirSync(path.dirname(USAGE_LOG_PATH), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(USAGE_LOG_PATH)) await workbook.xlsx.readFile(USAGE_LOG_PATH);
  let sheet = workbook.getWorksheet("Usage");
  if (!sheet) {
    sheet = workbook.addWorksheet("Usage");
    sheet.columns = [
      { header: "Name", key: "name", width: 28 }, { header: "File Name", key: "fileName", width: 42 },
      { header: "Date", key: "date", width: 16 }, { header: "Time", key: "time", width: 16 },
      { header: "Company", key: "company", width: 34 }, { header: "Status", key: "status", width: 24 }
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }
  const now = new Date();
  sheet.addRow({ name: safeText(name, 100), fileName: safeText(fileName, 255), date: now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }), time: now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }), company: safeText(company, 200), status: safeText(status, 100) });
  await workbook.xlsx.writeFile(USAGE_LOG_PATH);
}

app.post("/api/login", async (req, res) => {
  const name = safeText(req.body?.name, 100);
  const password = String(req.body?.password || "");
  if (!name) return res.status(400).json({ ok: false, error: "Enter your name." });
  if (ACCESS_PASSWORD && password !== ACCESS_PASSWORD) return res.status(401).json({ ok: false, error: "Incorrect access password." });
  const token = signSession(name, Date.now());
  res.setHeader("Set-Cookie", `finsight_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  await appendUsage({ name, status: "Entered site" });
  res.json({ ok: true, name });
});
app.get("/api/session", (req, res) => { const s = readSession(req); res.json({ ok: Boolean(s), name: s?.name || null }); });
app.post("/api/logout", (req, res) => { res.setHeader("Set-Cookie", "finsight_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"); res.json({ ok: true }); });
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/api/health", (req, res) => res.json({ ok: true, aiConfigured: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL, extraction: "gemini-only" }));

function geminiUrl() { return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`; }
function extractGeminiText(payload) { return (payload?.candidates?.[0]?.content?.parts || []).map(p => p?.text || "").join("\n").trim(); }
function safeJSON(text) {
  try { return JSON.parse(text); } catch {}
  try { return JSON.parse(String(text).replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim()); } catch { return null; }
}
function unitFactor(unit) {
  const u = String(unit || "").toLowerCase();
  if (/crore|cr\b/.test(u)) return 1;
  if (/million|\bmn\b/.test(u)) return 0.1;
  if (/lakh|lac/.test(u)) return 0.01;
  if (/billion|\bbn\b/.test(u)) return 100;
  if (/thousand|000/.test(u)) return 0.0001;
  return null;
}
function sharesToCrore(value, unit) {
  const n = finite(value); if (n == null) return null;
  const u = String(unit || "").toLowerCase();
  if (/crore|cr\b/.test(u)) return round(n);
  if (/lakh|lac/.test(u)) return round(n / 100);
  if (/million|\bmn\b/.test(u)) return round(n / 10);
  if (/billion|\bbn\b/.test(u)) return round(n * 100);
  if (/share|unit|absolute|number/.test(u)) return round(n / 10000000);
  return null;
}

function normalizeExtraction(raw) {
  if (Array.isArray(raw) && raw.length === 1) raw = raw[0];
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.financials)) throw new Error("Gemini returned invalid financial JSON.");
  const moneyFields = ["revenue","ebitda","operating_income","net_income","total_assets","current_assets","current_liabilities","total_debt","cash","total_equity","operating_cash_flow","capex","inventory","accounts_receivable","accounts_payable","finance_cost"];
  const rows = raw.financials.map(r => {
    const factor = unitFactor(r.source_unit); const year = Number(r.year);
    if (!Number.isInteger(year) || factor == null) return null;
    const row = { financial_year: r.financial_year || `FY${year - 1}-${String(year).slice(-2)}`, year, statement_basis: r.statement_basis || "Unknown", source_unit: "INR crore", original_source_unit: r.source_unit || null };
    for (const f of moneyFields) { const n = finite(r[f]); row[f] = n == null ? null : round(n * factor); }
    if (row.capex != null) row.capex = Math.abs(row.capex);
    if (row.finance_cost != null) row.finance_cost = Math.abs(row.finance_cost);
    row.shares_outstanding = sharesToCrore(r.shares_outstanding, r.shares_outstanding_unit);
    row.shares_outstanding_unit = row.shares_outstanding == null ? null : "crore shares";
    return row;
  }).filter(Boolean).sort((a,b) => a.year - b.year);
  if (!rows.length) throw new Error("Gemini returned no usable financial rows.");
  rows.forEach((row, i) => {
    const prev = rows[i - 1] || null;
    row.ebitda_margin = ratio(row.ebitda, row.revenue);
    row.operating_margin = ratio(row.operating_income, row.revenue);
    row.net_margin = ratio(row.net_income, row.revenue);
    row.current_ratio = ratio(row.current_assets, row.current_liabilities);
    row.net_debt = diff(row.total_debt, row.cash);
    row.simplified_fcf = row.operating_cash_flow != null && row.capex != null ? row.operating_cash_flow - row.capex : null;
    row.cash_conversion = ratio(row.operating_cash_flow, row.net_income);
    row.interest_coverage = ratio(row.operating_income, row.finance_cost);
    row.debt_equity = ratio(row.total_debt, row.total_equity);
    row.receivable_days = row.accounts_receivable != null && row.revenue > 0 ? row.accounts_receivable / row.revenue * 365 : null;
    const avgEq = prev?.total_equity != null && row.total_equity != null ? (prev.total_equity + row.total_equity) / 2 : null;
    const avgAssets = prev?.total_assets != null && row.total_assets != null ? (prev.total_assets + row.total_assets) / 2 : null;
    const currentCE = row.total_assets != null && row.current_liabilities != null ? row.total_assets - row.current_liabilities : null;
    const prevCE = prev?.total_assets != null && prev?.current_liabilities != null ? prev.total_assets - prev.current_liabilities : null;
    const avgCE = currentCE != null && prevCE != null ? (currentCE + prevCE) / 2 : null;
    row.roe = ratio(row.net_income, avgEq);
    row.roa = ratio(row.net_income, avgAssets);
    row.roce = ratio(row.operating_income, avgCE);
  });
  const company = raw.company && typeof raw.company === "object" ? raw.company : {};
  return { company: { name: company.name || company.legal_name || "Unknown company", legal_name: company.legal_name || company.name || "Unknown company", listing_status: company.listing_status || "unknown", ticker: company.ticker || null, exchange: company.exchange || null, isin: company.isin || null, currency: company.currency || "₹", extraction_confidence: "Gemini extracted" }, financials: rows, warnings: Array.isArray(raw.warnings) ? raw.warnings : [] };
}

app.post("/api/ai/extract-financials", requireSession, upload.single("report"), async (req, res) => {
  let fileName = req.file?.originalname || "";
  try {
    if (!GEMINI_API_KEY) throw Object.assign(new Error("Gemini API key is not configured."), { status: 503 });
    validatePdf(req.file);
    const prompt = `Extract audited annual-report financial data. Prefer consolidated statements. Never mix consolidated and standalone figures. Extract every reliably supported reporting year. Return monetary values exactly as printed and state the source unit. Missing or uncertain values must be null, never zero. Operating income means EBIT/operating profit; if the report does not explicitly provide or reliably support it, return null. Period-end shares only, not weighted-average EPS shares. Return JSON only with this structure: {"company":{"name":"","legal_name":"","listing_status":"listed|unlisted|pre-IPO|proposed listing|unknown","ticker":null,"exchange":null,"isin":null,"currency":"₹"},"financials":[{"financial_year":"","year":null,"statement_basis":"Consolidated|Standalone","source_unit":"INR crore|INR million|INR lakh|INR billion|INR thousand","revenue":null,"ebitda":null,"operating_income":null,"net_income":null,"total_assets":null,"current_assets":null,"current_liabilities":null,"total_debt":null,"cash":null,"total_equity":null,"operating_cash_flow":null,"capex":null,"inventory":null,"accounts_receivable":null,"accounts_payable":null,"finance_cost":null,"shares_outstanding":null,"shares_outstanding_unit":null}],"warnings":[]}`;
    const body = { contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "application/pdf", data: req.file.buffer.toString("base64") } }] }], generationConfig: { temperature: 0, responseMimeType: "application/json" } };
    const response = await fetch(geminiUrl(), { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const providerText = await response.text();
    let providerPayload; try { providerPayload = JSON.parse(providerText); } catch { providerPayload = { raw: providerText }; }
    if (!response.ok) {
      const msg = providerPayload?.error?.message || `Gemini HTTP ${response.status}`;
      const err = new Error(msg); err.status = response.status === 429 ? 429 : 502; throw err;
    }
    const text = extractGeminiText(providerPayload);
    const parsed = safeJSON(text);
    const result = normalizeExtraction(parsed);
    await appendUsage({ name: req.session.name, fileName, company: result.company.name, status: "Extraction success" });
    res.json({ ok: true, ...result, provider: "gemini", model: GEMINI_MODEL });
  } catch (error) {
    try { await appendUsage({ name: req.session?.name || "Unknown", fileName, status: `Extraction failed: ${safeText(error?.message, 70)}` }); } catch {}
    const status = Number(error?.status) || (error?.name === "TimeoutError" ? 504 : 500);
    res.status(status >= 400 && status <= 599 ? status : 500).json({ ok: false, error: error?.message || "Gemini extraction failed.", provider: "gemini" });
  }
});

app.get("/api/admin/usage.xlsx", requireSession, async (req, res) => {
  if (!fs.existsSync(USAGE_LOG_PATH)) return res.status(404).json({ ok: false, error: "No usage log exists yet." });
  res.download(USAGE_LOG_PATH, "finsight-usage.xlsx");
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "finsight-investor.html")));
app.use((req, res) => res.status(404).json({ ok: false, error: "Route not found" }));
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, error: "PDF exceeds the 45 MB limit." });
  res.status(500).json({ ok: false, error: error?.message || "Unexpected server error." });
});
app.listen(PORT, "0.0.0.0", () => console.log(`FinSight Gemini-only dashboard running on port ${PORT}`));
