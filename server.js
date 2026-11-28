/* ============================================================
   FINSIGHT — BACKEND (Node.js / Express)

   Annual-report PDF  →  Gemini  →  validated JSON
   →  dashboard  →  Supabase PostgreSQL usage log  →  Excel export

   This file is backend only. It never touches browser APIs.
   All secrets come from environment variables.
   ============================================================ */

import "dotenv/config";

import crypto from "node:crypto";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";
import pg from "pg";
import ExcelJS from "exceljs";
import pdfParse from "pdf-parse/lib/pdf-parse.js";


// Prefer IPv4 first: Render instances have no outbound IPv6.
dns.setDefaultResultOrder("ipv4first");

const __dirname = path.dirname(fileURLToPath(import.meta.url));


/* ============================================================
   1. CONFIGURATION
   ============================================================ */

const PORT = Number(process.env.PORT || 10000);

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const GEMINI_FALLBACK_MODEL = (process.env.GEMINI_FALLBACK_MODEL || "").trim();

const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const DATABASE_SSL = !/^(false|0|no|off|disable)$/i.test(
  (process.env.DATABASE_SSL || "true").trim()
);

// FINSIGHT_ACCESS_PASSWORD is accepted only as a legacy alias.
const SITE_PASSWORD =
  process.env.FINSIGHT_PASSWORD ||
  process.env.FINSIGHT_ACCESS_PASSWORD ||
  "";
const ADMIN_PASSWORD = process.env.FINSIGHT_ADMIN_PASSWORD || "";

let SESSION_SECRET = process.env.SESSION_SECRET || "";
let sessionSecretIsEphemeral = false;

if (!SESSION_SECRET) {
  // Do not crash; sessions simply will not survive a restart.
  SESSION_SECRET = crypto.randomBytes(48).toString("hex");
  sessionSecretIsEphemeral = true;
}

const IS_PRODUCTION =
  process.env.NODE_ENV === "production" || process.env.RENDER === "true";

const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
const INLINE_PDF_LIMIT_BYTES = 15 * 1024 * 1024;
const MAX_CONCURRENT_EXTRACTIONS = 3;
const GEMINI_TIMEOUT_MS = 240_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const USAGE_TIMEZONE = process.env.USAGE_TIMEZONE || "Asia/Kolkata";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

const databaseEnabled = Boolean(DATABASE_URL);
let databaseReady = false;


/* ============================================================
   2. DATABASE (Supabase PostgreSQL via pg) — INSERT-ONLY LOG
   ============================================================ */

const pool = databaseEnabled
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    })
  : null;

if (pool) {
  pool.on("error", error => {
    console.error("Database pool error:", error.message);
  });
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS usage_events (
    event_id UUID PRIMARY KEY,
    username TEXT NOT NULL,
    event_type TEXT NOT NULL,
    filename TEXT,
    company TEXT,
    report_year INTEGER,
    status TEXT,
    gemini_model TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS usage_events_created_at_idx
    ON usage_events (created_at);
`;

async function initDatabase() {
  if (!pool) {
    console.warn(
      "DATABASE_URL is not set. Usage logging is disabled."
    );
    return false;
  }

  try {
    await pool.query(CREATE_TABLE_SQL);
    databaseReady = true;
    console.log("FinSight database ready.");
    return true;
  } catch (error) {
    databaseReady = false;
    console.error(
      "Database connection failed:",
      error.code || "",
      error.message
    );

    if (["ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(error.code)) {
      console.error(
        "Hint: use the Supabase SESSION POOLER connection string " +
          "(host like aws-0-<region>.pooler.supabase.com, user postgres.<project-ref>) " +
          "in DATABASE_URL. The direct db.<ref>.supabase.co host is IPv6-only and " +
          "cannot be reached from Render."
      );
    } else if (error.code === "28P01") {
      console.error("Hint: wrong database password in DATABASE_URL.");
    }

    return false;
  }
}

function clip(value, max) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();

  return text ? text.slice(0, max) : null;
}

/**
 * Append one usage event. INSERT only. Never throws.
 * Returns true when the row was written.
 */
async function logEvent({
  username,
  eventType,
  filename = null,
  company = null,
  reportYear = null,
  status = null,
  geminiModel = null,
  errorMessage = null
}) {
  if (!pool) {
    return false;
  }

  try {
    if (!databaseReady) {
      await initDatabase();
    }

    if (!databaseReady) {
      return false;
    }

    await pool.query(
      `INSERT INTO usage_events
         (event_id, username, event_type, filename, company,
          report_year, status, gemini_model, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        clip(username, 120) || "unknown",
        clip(eventType, 60) || "event",
        clip(filename, 255),
        clip(company, 255),
        Number.isInteger(reportYear) ? reportYear : null,
        clip(status, 60),
        clip(geminiModel, 120),
        clip(errorMessage, 1000)
      ]
    );

    return true;
  } catch (error) {
    console.error(
      `Usage log insert failed (${eventType}):`,
      error.message
    );
    return false;
  }
}


/* ============================================================
   3. SESSIONS (signed HttpOnly cookie, no extra dependency)
   ============================================================ */

const COOKIE_NAME = "finsight_session";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function hmac(value) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("base64url");
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();

  return crypto.timingSafeEqual(left, right);
}

function createSessionToken(name, admin) {
  const payload = base64url(
    JSON.stringify({
      name,
      admin: Boolean(admin),
      exp: Date.now() + SESSION_TTL_MS
    })
  );

  return `${payload}.${hmac(payload)}`;
}

function readSessionToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const [payload, signature, extra] = token.split(".");

  if (!payload || !signature || extra !== undefined) {
    return null;
  }

  if (!safeEqual(signature, hmac(payload))) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (
      !data ||
      typeof data.name !== "string" ||
      !data.name ||
      typeof data.exp !== "number" ||
      data.exp < Date.now()
    ) {
      return null;
    }

    return { name: data.name, admin: Boolean(data.admin) };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const cookies = {};

  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");

    if (index > 0) {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(
        part.slice(index + 1).trim()
      );
    }
  }

  return cookies;
}

function setSessionCookie(res, token) {
  const flags = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];

  if (IS_PRODUCTION) {
    flags.push("Secure");
  }

  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearSessionCookie(res) {
  const flags = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (IS_PRODUCTION) {
    flags.push("Secure");
  }

  res.setHeader("Set-Cookie", flags.join("; "));
}

function attachSession(req, _res, next) {
  req.session = readSessionToken(
    parseCookies(req.headers.cookie)[COOKIE_NAME]
  );
  next();
}

function requireAuth(req, res, next) {
  if (!req.session) {
    return res.status(401).json({
      ok: false,
      error: "Please log in to continue."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session) {
    return res.status(401).json({
      ok: false,
      error: "Please log in to continue."
    });
  }

  if (!req.session.admin) {
    return res.status(403).json({
      ok: false,
      error: "Administrator access required."
    });
  }

  next();
}

// Simple in-memory brute-force guard for the login endpoint.
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

function loginBlocked(ip) {
  const entry = loginFailures.get(ip);

  if (!entry) {
    return false;
  }

  if (entry.resetAt < Date.now()) {
    loginFailures.delete(ip);
    return false;
  }

  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const entry = loginFailures.get(ip);

  if (!entry || entry.resetAt < Date.now()) {
    loginFailures.set(ip, {
      count: 1,
      resetAt: Date.now() + LOGIN_WINDOW_MS
    });
  } else {
    entry.count += 1;
  }
}

function cleanName(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}


/* ============================================================
   4. EXTRACTION CORE (pure logic: Gemini client, normalization,
      validation). Kept in one marked region so it can be unit
      tested without starting the web server.
   ============================================================ */

// ==== PURE:BEGIN

class ExtractionError extends Error {
  constructor(message, httpStatus = 502, kind = "extraction") {
    super(message);
    this.name = "ExtractionError";
    this.httpStatus = httpStatus;
    this.kind = kind;
  }
}

const NUMERIC_FIELDS = [
  "revenue",
  "total_income",
  "other_income",
  "ebitda",
  "net_income",
  "finance_cost",
  "profit_before_tax",
  "depreciation_amortisation",
  "exceptional_items",
  "total_assets",
  "current_assets",
  "current_liabilities",
  "total_debt",
  "cash",
  "total_equity",
  "inventory",
  "accounts_receivable",
  "accounts_payable",
  "operating_cash_flow",
  "capex"
];

// Inputs needed to derive EBITDA when the report does not print it.
const EBITDA_INPUTS = [
  "profit_before_tax",
  "depreciation_amortisation",
  "finance_cost",
  "other_income"
];

// Fields whose absence usually means a statement was not searched.
const CORE_FIELDS = [
  "total_assets",
  "current_assets",
  "current_liabilities",
  "total_equity",
  "total_debt",
  "cash",
  "accounts_receivable",
  "operating_cash_flow",
  "capex"
];

const SOURCE_UNITS = [
  "INR crore",
  "INR lakh",
  "INR million",
  "INR billion",
  "INR thousand",
  "INR"
];

// Multiplier that converts a value in the source unit to INR crore.
const UNIT_TO_CRORE = {
  "inr crore": 1,
  "inr lakh": 1 / 100,
  "inr million": 1 / 10,
  "inr billion": 100,
  "inr thousand": 1 / 10_000,
  "inr": 1 / 10_000_000
};

const MONEY_DECIMALS = 2;


/* ---------- Gemini request schema ---------- */

function nullableNumber(description) {
  return { type: "NUMBER", nullable: true, description };
}

function buildResponseSchema() {
  const rowProperties = {
    financial_year: {
      type: "STRING",
      description: 'Financial year label such as "2025-26".'
    },
    year: {
      type: "INTEGER",
      description: "Calendar year in which the financial year ENDS (2025-26 -> 2026)."
    },
    statement_basis: {
      type: "STRING",
      enum: ["Consolidated", "Standalone"]
    },
    source_unit: {
      type: "STRING",
      enum: SOURCE_UNITS,
      description:
        "The unit in which the statements print their numbers. All monetary values in this object MUST be in this unit."
    },
    revenue: nullableNumber("Revenue from operations."),
    total_income: nullableNumber("Total income (revenue + other income)."),
    other_income: nullableNumber("Other income."),
    ebitda: nullableNumber("EBITDA if reported or reliably derivable."),
    net_income: nullableNumber("Profit/loss for the year after tax (total, including non-controlling interest)."),
    finance_cost: nullableNumber("Finance costs (positive number)."),
    profit_before_tax: nullableNumber("Profit/loss before tax (and before share of JV/associates only if the statement shows it separately above PBT; use the PBT line as printed)."),
    depreciation_amortisation: nullableNumber("Depreciation and amortisation expense (positive number)."),
    exceptional_items: nullableNumber("Exceptional items included in profit before tax, signed as a P&L effect: gain positive, expense negative. 0 if none shown."),
    total_assets: nullableNumber("Total assets."),
    current_assets: nullableNumber("Total current assets."),
    current_liabilities: nullableNumber("Total current liabilities."),
    total_debt: nullableNumber("Current + non-current borrowings."),
    cash: nullableNumber("Cash and cash equivalents."),
    total_equity: nullableNumber("Total equity (including non-controlling interest)."),
    inventory: nullableNumber("Inventories."),
    accounts_receivable: nullableNumber("Trade receivables."),
    accounts_payable: nullableNumber("Trade payables."),
    operating_cash_flow: nullableNumber("Net cash from operating activities."),
    capex: nullableNumber("Cash spent on property, plant, equipment and intangibles (positive number)."),
    shares_outstanding: nullableNumber("Number of equity shares outstanding as an ABSOLUTE COUNT (not in lakh/crore/million)."),
    source_pages: {
      type: "ARRAY",
      items: { type: "INTEGER" },
      description: "PDF page numbers (1-based) where the values were found."
    },
    extraction_notes: {
      type: "STRING",
      nullable: true,
      description: "Short note: derivations, composition of debt/cash, caveats."
    }
  };

  return {
    type: "OBJECT",
    properties: {
      company: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          legal_name: { type: "STRING", nullable: true },
          ticker: { type: "STRING", nullable: true },
          exchange: { type: "STRING", nullable: true },
          isin: { type: "STRING", nullable: true },
          currency: { type: "STRING" },
          extraction_confidence: {
            type: "STRING",
            enum: ["High", "Medium", "Low"]
          }
        },
        required: ["name", "currency", "extraction_confidence"]
      },
      financials: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: rowProperties,
          required: [
            "financial_year",
            "year",
            "statement_basis",
            "source_unit",
            ...NUMERIC_FIELDS,
            "shares_outstanding",
            "source_pages"
          ]
        }
      },
      validation: {
        type: "OBJECT",
        properties: {
          warnings: { type: "ARRAY", items: { type: "STRING" } }
        }
      }
    },
    required: ["company", "financials"]
  };
}

const SYSTEM_INSTRUCTION = `You are a meticulous financial-data extraction engine for annual reports.
You read the PDF itself (text, tables and scanned pages) and return JSON only, matching the supplied schema.
You never guess. A value is null only when the report does not reliably support it after you have searched the relevant statements and notes.
You never perform ratio calculations; you only extract reported figures (and the single permitted EBITDA derivation described by the user).`;

const EXTRACTION_PROMPT = `Extract structured financial data from this annual report.

STATEMENT BASIS
- Use the AUDITED CONSOLIDATED financial statements whenever the report contains them.
- Use standalone statements only if no consolidated statements exist, and then set statement_basis to "Standalone".
- Never mix consolidated and standalone values in the same year or across years.

YEARS
- Return one object per financial year found in the audited statements (current year AND the comparative prior year(s)).
- Do not combine years. Do not use unaudited multi-year summaries unless the audited statements lack that year.
- financial_year looks like "2025-26"; year is the calendar year in which that financial year ends (2026).

HOW TO WORK - search each statement explicitly, one by one, for every year:
1. STATEMENT OF PROFIT AND LOSS: revenue (revenue from operations), other income, total income, finance costs, profit/loss for the year after tax (net_income), and EBITDA.
2. BALANCE SHEET (statement of financial position): total assets, total current assets, total current liabilities, total equity, borrowings (current and non-current), cash and cash equivalents, trade receivables, inventories, trade payables.
3. CASH FLOW STATEMENT: net cash generated from operating activities, and capital expenditure from the investing section (purchase of property, plant and equipment, intangible assets, capital work-in-progress, investment property, net of proceeds from sales is NOT required: use the gross purchase outflow).
4. NOTES to the financial statements: borrowings note (debt), cash and cash equivalents note, trade receivables note, share capital note (shares outstanding).
Balance-sheet and cash-flow items are as important as income-statement items. Do not stop after finding revenue and profit.

DEFINITIONS
- revenue: revenue from operations (not total income).
- total_income: total income as printed; other_income: other income as printed.
- ebitda: the EBITDA exactly as the report presents it (audited statements, key financial summary, MD&A or directors' report). If the report does not present EBITDA, return null for ebitda - FinSight will derive it - but you MUST then fill profit_before_tax, depreciation_amortisation, finance_cost, other_income and exceptional_items from the statement of profit and loss.
- profit_before_tax: the "Profit before tax" line (after exceptional items, as printed). For groups with share of profit of joint ventures/associates shown above PBT, use the line the statement labels profit before tax.
- depreciation_amortisation: "Depreciation and amortisation expense" from the statement of profit and loss (positive number).
- exceptional_items: exceptional items shown in the statement of profit and loss, as a P&L effect (gain positive, expense negative); 0 if none.
- net_income: profit/loss for the year after tax, total (including non-controlling interest), as printed in the statement of profit and loss.
- finance_cost: finance costs / interest expense, positive number.
- total_equity: total equity (including non-controlling interest) as printed on the balance sheet.
- total_debt: current borrowings + non-current borrowings (include current maturities of long-term borrowings). Exclude trade payables, provisions, deferred tax and other liabilities. Exclude lease liabilities unless the company reports them within borrowings; say what you included in extraction_notes. If the company genuinely has no borrowings, return 0, not null.
- cash: cash and cash equivalents as on the balance sheet (not other bank balances, not current investments); say in extraction_notes if the balance sheet line combines more.
- accounts_receivable: trade receivables (net of allowance).
- accounts_payable: trade payables.
- operating_cash_flow: net cash generated from / (used in) operating activities.
- capex: positive number, gross cash outflow for purchase of property, plant and equipment and intangible assets (including capital work-in-progress and capital advances if the line combines them).
- shares_outstanding: number of issued and paid-up equity shares as an absolute count (for example 2475123456), not in lakh, crore or million.

UNITS
- Report values exactly as printed, in the unit the statements use, and set source_unit accordingly ("INR crore", "INR lakh", "INR million", "INR billion", "INR thousand" or "INR" for whole rupees).
- Do NOT convert units yourself. Every monetary number in a year object must be in that object's source_unit.
- Losses and cash outflows: net_income and operating_cash_flow keep their sign (negative if a loss/outflow). capex and finance_cost are positive.

OUTPUT
- source_pages: PDF page numbers (1-based page index of the PDF file) where the values for that year were found.
- extraction_notes: short, factual; mention derivations, what is included in debt/cash, and any doubt.
- company.currency: ISO code (INR for rupee reports). company.extraction_confidence: High / Medium / Low.
- validation.warnings: anything suspicious you noticed.
- Return JSON only.`;

function buildGapFillPrompt(gaps, basis) {
  const lines = gaps.map(
    gap => `- ${gap.financial_year}: ${gap.fields.join(", ")}`
  );

  return `A first extraction of this annual report left the fields below empty. Search the report again, specifically:
- balance sheet and its notes for: total_assets, current_assets, current_liabilities, total_equity, total_debt (borrowings note), cash (cash and cash equivalents note), accounts_receivable (trade receivables note);
- cash flow statement for: operating_cash_flow, and the investing section for capex.
For EBITDA: if the report does not print an EBITDA figure, fill profit_before_tax, depreciation_amortisation, finance_cost, other_income and exceptional_items from the statement of profit and loss instead (FinSight derives EBITDA from them).
Use ${basis || "Consolidated"} statements. Return the same JSON structure, with one object per financial year listed below. Fill the listed fields only when the report supports them; otherwise leave them null. Apply the same definitions and units rules as before (values in the printed unit, set source_unit).

Missing fields:
${lines.join("\n")}

${EXTRACTION_PROMPT}`;
}


/* ---------- Gemini HTTP client ---------- */

class GeminiError extends Error {
  constructor(message, { httpStatus = 502, kind = "gemini" } = {}) {
    super(message);
    this.name = "GeminiError";
    this.httpStatus = httpStatus;
    this.kind = kind;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function upstreamMessage(body) {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    return String(parsed?.error?.message || "").slice(0, 200);
  } catch {
    return String(body || "").slice(0, 200);
  }
}

function mapGeminiHttpError(status, body, model) {
  const detail = upstreamMessage(body);
  const lowered = detail.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    (status === 400 && lowered.includes("api key"))
  ) {
    return new GeminiError(
      "Gemini API key is invalid or not permitted to use this model. Check GEMINI_API_KEY.",
      { httpStatus: 502, kind: "auth" }
    );
  }

  if (status === 404) {
    return new GeminiError(
      `Gemini model "${model}" is unavailable. Check GEMINI_MODEL.`,
      { httpStatus: 502, kind: "model" }
    );
  }

  if (status === 429) {
    return new GeminiError(
      "Gemini quota exceeded. Wait a few minutes or check your Gemini API plan.",
      { httpStatus: 429, kind: "quota" }
    );
  }

  if (status === 413 || (status === 400 && /size|too large|exceed/.test(lowered))) {
    return new GeminiError(
      `Gemini rejected the request as too large${detail ? `: ${detail}` : "."}`,
      { httpStatus: 413, kind: "size" }
    );
  }

  if (status >= 500) {
    return new GeminiError(
      "Gemini is temporarily unavailable or overloaded. Please try again.",
      { httpStatus: 503, kind: "overloaded" }
    );
  }

  return new GeminiError(
    `Gemini request failed (HTTP ${status})${detail ? `: ${detail}` : "."}`,
    { httpStatus: 502, kind: "request" }
  );
}

async function geminiFetch(url, options, model, timeoutMs = GEMINI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new GeminiError(
        "Gemini took too long to respond. Try again or use a smaller report.",
        { httpStatus: 504, kind: "timeout" }
      );
    }

    throw new GeminiError(
      `Could not reach Gemini (${error?.cause?.code || error?.message || "network error"}).`,
      { httpStatus: 502, kind: "network" }
    );
  } finally {
    clearTimeout(timer);
  }
}

function geminiHeaders(extra = {}) {
  return { "x-goog-api-key": GEMINI_API_KEY, ...extra };
}

/** Upload a large PDF through the Gemini Files API. */
async function uploadPdfToGemini(buffer, model) {
  const start = await geminiFetch(
    `${GEMINI_API_BASE}/upload/v1beta/files`,
    {
      method: "POST",
      headers: geminiHeaders({
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(buffer.length),
        "X-Goog-Upload-Header-Content-Type": "application/pdf"
      }),
      body: JSON.stringify({ file: { display_name: "annual-report.pdf" } })
    },
    model,
    60_000
  );

  if (!start.ok) {
    throw mapGeminiHttpError(start.status, await start.text(), model);
  }

  const uploadUrl = start.headers.get("x-goog-upload-url");

  if (!uploadUrl) {
    throw new GeminiError("Gemini file upload did not return an upload URL.");
  }

  const upload = await geminiFetch(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "Content-Length": String(buffer.length),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      body: buffer
    },
    model,
    180_000
  );

  if (!upload.ok) {
    throw mapGeminiHttpError(upload.status, await upload.text(), model);
  }

  let file = (await upload.json())?.file;

  if (!file?.uri || !file?.name) {
    throw new GeminiError("Gemini file upload returned an unexpected response.");
  }

  for (let attempt = 0; attempt < 30 && file.state && file.state !== "ACTIVE"; attempt += 1) {
    if (file.state === "FAILED") {
      throw new GeminiError("Gemini could not process the uploaded PDF.");
    }

    await sleep(2000);

    const poll = await geminiFetch(
      `${GEMINI_API_BASE}/v1beta/${file.name}`,
      { headers: geminiHeaders() },
      model,
      30_000
    );

    if (!poll.ok) {
      throw mapGeminiHttpError(poll.status, await poll.text(), model);
    }

    file = await poll.json();
  }

  if (file.state && file.state !== "ACTIVE") {
    throw new GeminiError("Gemini took too long to process the uploaded PDF.", {
      httpStatus: 504,
      kind: "timeout"
    });
  }

  return file;
}

async function deleteGeminiFile(file) {
  if (!file?.name) {
    return;
  }

  try {
    await geminiFetch(
      `${GEMINI_API_BASE}/v1beta/${file.name}`,
      { method: "DELETE", headers: geminiHeaders() },
      GEMINI_MODEL,
      15_000
    );
  } catch {
    // best effort: files auto-expire after 48 hours anyway
  }
}

/** Returns { part, cleanup } for the PDF. Inline when small, Files API when large. */
async function preparePdfPart(buffer, model) {
  if (buffer.length <= INLINE_PDF_LIMIT_BYTES) {
    return {
      part: {
        inlineData: {
          mimeType: "application/pdf",
          data: buffer.toString("base64")
        }
      },
      cleanup: async () => {}
    };
  }

  const file = await uploadPdfToGemini(buffer, model);

  return {
    part: { fileData: { mimeType: "application/pdf", fileUri: file.uri } },
    cleanup: () => deleteGeminiFile(file)
  };
}

function parseGeminiJson(text) {
  let cleaned = String(text || "").trim();

  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");

    if (first >= 0 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        // fall through
      }
    }
  }

  throw new GeminiError(
    "Gemini returned invalid JSON. Please try again.",
    { httpStatus: 502, kind: "json" }
  );
}

/** One generateContent call against one model. */
async function generateOnce({ model, pdfPart, prompt }) {
  const response = await geminiFetch(
    `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: geminiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [pdfPart, { text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: buildResponseSchema(),
          maxOutputTokens: 16384
        }
      })
    },
    model
  );

  const raw = await response.text();

  if (!response.ok) {
    throw mapGeminiHttpError(response.status, raw, model);
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new GeminiError("Gemini returned an unreadable response.");
  }

  if (data?.promptFeedback?.blockReason) {
    throw new GeminiError(
      `Gemini blocked this request (${data.promptFeedback.blockReason}).`,
      { httpStatus: 422, kind: "blocked" }
    );
  }

  const candidate = data?.candidates?.[0];

  if (!candidate) {
    throw new GeminiError("Gemini returned no answer for this report.");
  }

  if (candidate.finishReason === "MAX_TOKENS") {
    throw new GeminiError(
      "Gemini's answer was cut off before it finished. Please try again.",
      { httpStatus: 502, kind: "json" }
    );
  }

  const text = (candidate.content?.parts || [])
    .filter(part => !part.thought && typeof part.text === "string")
    .map(part => part.text)
    .join("");

  if (!text.trim()) {
    throw new GeminiError("Gemini returned an empty answer.");
  }

  return parseGeminiJson(text);
}

const RETRY_DELAYS_MS = [2000, 6000];
const RETRYABLE_KINDS = new Set(["overloaded", "quota", "network", "json"]);
const FALLBACK_KINDS = new Set(["overloaded", "quota", "model", "network", "timeout", "json"]);

/** Primary model with retries, then optional fallback model. */
async function runGemini({ pdfPart, prompt, retryDelays = RETRY_DELAYS_MS }) {
  const models = [GEMINI_MODEL];

  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
    models.push(GEMINI_FALLBACK_MODEL);
  }

  let lastError = null;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];

    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        return { data: await generateOnce({ model, pdfPart, prompt }), model };
      } catch (error) {
        lastError = error;

        if (!(error instanceof GeminiError)) {
          throw error;
        }

        if (!RETRYABLE_KINDS.has(error.kind) || attempt === retryDelays.length) {
          break;
        }

        await sleep(retryDelays[attempt]);
      }
    }

    const hasNext = index < models.length - 1;

    if (!hasNext || !FALLBACK_KINDS.has(lastError.kind)) {
      break;
    }

    console.warn(
      `Gemini model "${model}" failed (${lastError.kind}). Trying fallback model.`
    );
  }

  throw lastError;
}


/* ---------- Normalization ---------- */

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let text = String(value).trim();

  if (!text || /^(n\/?a|na|null|nil|-|—|–)$/i.test(text)) {
    return null;
  }

  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text.replace(/[₹$£€,\s]/g, "");

  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }

  const number = Number(text);

  if (!Number.isFinite(number)) {
    return null;
  }

  return negative ? -number : number;
}

function cleanText(value, max = 300) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).replace(/\s+/g, " ").trim();

  return text ? text.slice(0, max) : null;
}

function parseYear(rawYear, label) {
  const direct = toNumber(rawYear);

  if (Number.isInteger(direct) && direct >= 1990 && direct <= 2100) {
    return direct;
  }

  const text = String(label ?? "");
  const range = text.match(/(\d{4})\s*[-–/]\s*(\d{2,4})/);

  if (range) {
    const start = Number(range[1]);
    const endText = range[2];
    const end = endText.length === 2
      ? Math.floor(start / 100) * 100 + Number(endText)
      : Number(endText);

    return end >= start ? end : start + 1;
  }

  const single = text.match(/(19|20)\d{2}/);

  return single ? Number(single[0]) : null;
}

function unitFactor(sourceUnit) {
  const key = String(sourceUnit || "").trim().toLowerCase().replace(/[₹]/g, "inr ").replace(/\s+/g, " ").trim();

  const aliases = {
    "inr crore": "inr crore",
    "inr crores": "inr crore",
    "inr cr": "inr crore",
    "crore": "inr crore",
    "crores": "inr crore",
    "inr lakh": "inr lakh",
    "inr lakhs": "inr lakh",
    "inr lac": "inr lakh",
    "inr lacs": "inr lakh",
    "lakh": "inr lakh",
    "lakhs": "inr lakh",
    "inr million": "inr million",
    "inr millions": "inr million",
    "inr mn": "inr million",
    "million": "inr million",
    "inr billion": "inr billion",
    "inr bn": "inr billion",
    "billion": "inr billion",
    "inr thousand": "inr thousand",
    "inr thousands": "inr thousand",
    "thousand": "inr thousand",
    "inr": "inr",
    "rupees": "inr",
    "inr rupees": "inr"
  };

  const canonical = aliases[key];

  return canonical
    ? { label: SOURCE_UNITS.find(unit => unit.toLowerCase() === canonical), factor: UNIT_TO_CRORE[canonical] }
    : null;
}

function roundMoney(value) {
  const factor = 10 ** MONEY_DECIMALS;

  return Math.round(value * factor) / factor;
}

/** Convert one raw Gemini row to the dashboard row. Returns { row, warnings }. */
function normalizeRow(raw) {
  const warnings = [];

  if (!raw || typeof raw !== "object") {
    return { row: null, warnings };
  }

  const year = parseYear(raw.year, raw.financial_year);

  if (!year) {
    return { row: null, warnings: ["A financial-year row without a readable year was ignored."] };
  }

  let label = cleanText(raw.financial_year, 20);

  if (label) {
    label = label.replace(/^FY\s*/i, "").replace(/\s+/g, "");
  }

  if (!label || !/\d{4}/.test(label)) {
    label = `${year - 1}-${String(year).slice(-2)}`;
  }

  const unit = unitFactor(raw.source_unit);
  const displayLabel = `FY${label}`;

  if (!unit) {
    return {
      row: null,
      warnings: [
        `${displayLabel}: unrecognised source unit "${cleanText(raw.source_unit, 40) || "missing"}"; the year was skipped rather than guessed.`
      ]
    };
  }

  const basis = /standalone/i.test(String(raw.statement_basis || ""))
    ? "Standalone"
    : "Consolidated";

  const row = {
    financial_year: label,
    year,
    statement_basis: basis,
    source_unit: unit.label,
    unit: "INR crore"
  };

  for (const field of NUMERIC_FIELDS) {
    let value = toNumber(raw[field]);

    if (value !== null) {
      if (field === "capex" || field === "finance_cost") {
        value = Math.abs(value);
      }

      value = roundMoney(value * unit.factor);
    }

    row[field] = value;
  }

  const shares = toNumber(raw.shares_outstanding);

  row.shares_outstanding = shares !== null && shares > 0 ? Math.round(shares) : null;

  if (row.shares_outstanding !== null && row.shares_outstanding < 1000) {
    warnings.push(
      `${displayLabel}: shares outstanding (${row.shares_outstanding}) looks too small to be an absolute share count; verify against the report.`
    );
  }

  const pages = Array.isArray(raw.source_pages)
    ? raw.source_pages
    : [];

  row.source_pages = [
    ...new Set(
      pages
        .map(toNumber)
        .filter(page => Number.isInteger(page) && page > 0 && page < 5000)
    )
  ]
    .sort((a, b) => a - b)
    .slice(0, 30);

  row.extraction_notes = cleanText(raw.extraction_notes, 600);

  return { row, warnings };
}

/**
 * If the report did not print EBITDA, derive it from reported inputs:
 *   EBITDA = PBT - exceptional items + finance cost + D&A - other income
 * Only when every input is available. Never overwrites a reported value.
 */
function deriveEbitda(row) {
  if (row.ebitda !== null) {
    return false;
  }

  const inputs = EBITDA_INPUTS.map(field => row[field]);

  if (inputs.some(value => value === null)) {
    return false;
  }

  const exceptional = row.exceptional_items ?? 0;

  row.ebitda = roundMoney(
    row.profit_before_tax -
      exceptional +
      row.finance_cost +
      row.depreciation_amortisation -
      row.other_income
  );

  const note =
    "EBITDA derived by FinSight: profit before tax" +
    (exceptional ? " - exceptional items" : "") +
    " + finance costs + depreciation & amortisation - other income.";

  row.extraction_notes = row.extraction_notes
    ? `${row.extraction_notes} ${note}`.slice(0, 700)
    : note;

  return true;
}

function filledCount(row) {
  return NUMERIC_FIELDS.filter(field => row[field] !== null).length;
}

function normalizeCompany(raw) {
  const company = raw && typeof raw === "object" ? raw : {};

  const confidence = ["High", "Medium", "Low"].find(
    level => level.toLowerCase() === String(company.extraction_confidence || "").toLowerCase()
  );

  return {
    name: cleanText(company.name, 200) || cleanText(company.legal_name, 200) || "Unknown company",
    legal_name: cleanText(company.legal_name, 200),
    ticker: cleanText(company.ticker, 40),
    exchange: cleanText(company.exchange, 60),
    isin: cleanText(company.isin, 20),
    currency: (cleanText(company.currency, 8) || "INR").toUpperCase(),
    extraction_confidence: confidence || "Medium"
  };
}

/**
 * Normalizes Gemini's raw object to the strict dashboard contract.
 * Returns { company, financials, validation }.
 */
function normalizeExtraction(raw) {
  const warnings = [];
  const company = normalizeCompany(raw?.company);

  if (company.currency !== "INR") {
    throw new ExtractionError(
      `This report is presented in ${company.currency}. FinSight currently normalizes INR reports to crore only.`,
      422,
      "currency"
    );
  }

  const rawRows = Array.isArray(raw?.financials) ? raw.financials : [];
  const rows = [];

  for (const item of rawRows) {
    const result = normalizeRow(item);

    warnings.push(...result.warnings);

    if (result.row) {
      rows.push(result.row);
    }
  }

  // One row per year: prefer Consolidated, then the more complete row.
  const byYear = new Map();
  let duplicates = 0;

  for (const row of rows) {
    const existing = byYear.get(row.year);

    if (!existing) {
      byYear.set(row.year, row);
      continue;
    }

    duplicates += 1;

    const better =
      (row.statement_basis === "Consolidated" && existing.statement_basis !== "Consolidated") ||
      (row.statement_basis === existing.statement_basis && filledCount(row) > filledCount(existing));

    if (better) {
      byYear.set(row.year, row);
    }
  }

  if (duplicates) {
    warnings.push(
      `${duplicates} duplicate financial-year row(s) returned by Gemini were dropped (Consolidated preferred).`
    );
  }

  const financials = [...byYear.values()].sort((a, b) => a.year - b.year);

  financials.forEach(deriveEbitda);

  if (rows.length > 1) {
    const original = rows.map(row => row.year);
    const sortedOriginal = [...original].sort((a, b) => a - b);

    if (original.some((year, index) => year !== sortedOriginal[index])) {
      warnings.push("Gemini returned the years out of order; they were re-ordered oldest to newest.");
    }
  }

  warnings.push(...sanityChecks(financials));

  const bases = new Set(financials.map(row => row.statement_basis));
  const allConsolidated = financials.length > 0 && bases.size === 1 && bases.has("Consolidated");

  if (financials.length && !allConsolidated) {
    warnings.push(
      bases.size > 1
        ? "Reporting years use different statement bases (Consolidated and Standalone); compare them with care."
        : "Only standalone statements were extracted; consolidated statements were not found."
    );
  }

  const geminiWarnings = Array.isArray(raw?.validation?.warnings)
    ? raw.validation.warnings.map(item => cleanText(item, 300)).filter(Boolean)
    : [];

  return {
    company,
    financials,
    validation: {
      consolidated_preferred: allConsolidated,
      years_found: financials.map(row => row.financial_year),
      warnings: [...new Set([...warnings, ...geminiWarnings.map(item => `Gemini note: ${item}`)])]
    }
  };
}


/* ---------- Sanity checks (report, never silently fix) ---------- */

function sanityChecks(rows) {
  const warnings = [];

  for (const row of rows) {
    const tag = `FY${row.financial_year}`;
    const v = field => row[field];
    const has = field => row[field] !== null && row[field] !== undefined;
    const warn = message => warnings.push(`${tag}: ${message}`);

    for (const field of ["revenue", "total_assets", "current_assets", "current_liabilities", "total_debt", "cash", "inventory", "accounts_receivable", "accounts_payable"]) {
      if (has(field) && v(field) < 0) {
        warn(`${field.replaceAll("_", " ")} is negative (${v(field)}); verify against the report.`);
      }
    }

    if (has("revenue") && has("total_assets") && v("revenue") === v("total_assets")) {
      warn("revenue equals total assets, which usually indicates a mis-read line.");
    }

    if (has("current_assets") && has("total_assets") && v("current_assets") > v("total_assets")) {
      warn("current assets exceed total assets.");
    }

    if (has("current_liabilities") && has("total_assets") && v("current_liabilities") > v("total_assets")) {
      warn("current liabilities exceed total assets.");
    }

    if (has("total_debt") && has("total_assets") && v("total_debt") > v("total_assets")) {
      warn("total debt exceeds total assets; debt may include unrelated liabilities.");
    }

    if (has("total_equity") && has("total_assets") && v("total_equity") > v("total_assets")) {
      warn("total equity exceeds total assets.");
    }

    if (has("cash") && has("current_assets")) {
      if (v("cash") > v("current_assets")) {
        warn("cash exceeds total current assets.");
      } else if (v("current_assets") > 0 && Math.abs(v("cash") - v("current_assets")) < 0.5) {
        warn("cash equals total current assets; cash may have been mistaken for the current-assets total.");
      }
    }

    if (has("cash") && has("total_assets") && v("cash") > v("total_assets")) {
      warn("cash exceeds total assets.");
    }

    if (has("inventory") && has("current_assets") && v("inventory") > v("current_assets")) {
      warn("inventories exceed total current assets.");
    }

    if (has("accounts_receivable") && has("current_assets") && v("accounts_receivable") > v("current_assets")) {
      warn("trade receivables exceed total current assets.");
    }

    if (has("revenue") && v("revenue") > 0 && has("ebitda") && v("ebitda") > v("revenue")) {
      warn("EBITDA exceeds revenue; verify the EBITDA definition.");
    }

    if (has("revenue") && has("total_income") && v("total_income") < v("revenue") * 0.99) {
      warn("total income is lower than revenue; verify both lines.");
    }

    if (has("revenue") && v("revenue") > 0 && has("net_income") && Math.abs(v("net_income")) > v("revenue")) {
      warn("net profit is larger than revenue (may be genuine if driven by other income or exceptional gains).");
    }

    if (has("capex") && has("total_assets") && v("capex") > v("total_assets")) {
      warn("capital expenditure exceeds total assets.");
    }

    if (has("operating_cash_flow") && has("total_assets") && Math.abs(v("operating_cash_flow")) > v("total_assets")) {
      warn("operating cash flow is larger than total assets.");
    }
  }

  // Cross-year checks
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];

    if (current.year - previous.year > 1) {
      warnings.push(
        `Years FY${previous.financial_year} and FY${current.financial_year} are not consecutive.`
      );
    }

    for (const field of ["revenue", "total_assets"]) {
      const a = previous[field];
      const b = current[field];

      if (a && b && a > 0 && b > 0 && (b / a > 10 || a / b > 10)) {
        warnings.push(
          `FY${current.financial_year}: ${field.replace("_", " ")} changed more than 10x versus FY${previous.financial_year}; possible unit mismatch.`
        );
      }
    }
  }

  const units = new Set(rows.map(row => row.source_unit));

  if (units.size > 1) {
    warnings.push(
      `Reporting years were printed in different units (${[...units].join(", ")}); all were converted to INR crore.`
    );
  }

  return warnings;
}


/* ---------- Gap detection / merge ---------- */

function findGaps(financials) {
  return financials
    .map(row => ({
      financial_year: row.financial_year,
      year: row.year,
      fields: [
        ...CORE_FIELDS.filter(field => row[field] === null),
        ...(row.ebitda === null
          ? ["ebitda", ...EBITDA_INPUTS, "exceptional_items"].filter(
              field => row[field] === null
            )
          : [])
      ]
    }))
    .filter(gap => gap.fields.length > 0);
}

/** Fill only null fields from a second extraction. Existing values win. */
function mergeGapFill(financials, fillRows) {
  const filled = [];

  for (const row of financials) {
    const donor = fillRows.find(
      candidate =>
        candidate.year === row.year &&
        candidate.statement_basis === row.statement_basis
    );

    if (!donor) {
      continue;
    }

    for (const field of [...CORE_FIELDS, "ebitda", ...EBITDA_INPUTS, "exceptional_items"]) {
      if (row[field] === null && donor[field] !== null) {
        row[field] = donor[field];
        filled.push(`${row.financial_year}:${field}`);

        for (const page of donor.source_pages) {
          if (!row.source_pages.includes(page)) {
            row.source_pages.push(page);
          }
        }
      }
    }

    row.source_pages.sort((a, b) => a - b);

    if (deriveEbitda(row)) {
      filled.push(`${row.financial_year}:ebitda`);
    }
  }

  return filled;
}

/**
 * Full extraction pipeline for one PDF buffer.
 * Pass 1: full extraction. Pass 2 (only if core balance-sheet /
 * cash-flow fields are empty): targeted search for those fields.
 */
async function extractFinancials(buffer, { retryDelays } = {}) {
  const { part, cleanup } = await preparePdfPart(buffer, GEMINI_MODEL);

  try {
    const first = await runGemini({
      pdfPart: part,
      prompt: EXTRACTION_PROMPT,
      retryDelays
    });

    const result = normalizeExtraction(first.data);
    let modelUsed = first.model;

    if (result.financials.length) {
      const gaps = findGaps(result.financials);

      if (gaps.length) {
        try {
          const basis = result.financials[result.financials.length - 1].statement_basis;
          const second = await runGemini({
            pdfPart: part,
            prompt: buildGapFillPrompt(gaps, basis),
            retryDelays
          });

          const secondResult = normalizeExtraction(second.data);
          const filled = mergeGapFill(result.financials, secondResult.financials);

          if (filled.length) {
            // Re-run sanity checks on the merged rows; keep earlier warnings that are not row checks.
            result.validation.warnings = [
              ...new Set([
                ...result.validation.warnings.filter(item => !/^FY\d/.test(item)),
                ...sanityChecks(result.financials)
              ])
            ];
          }

          modelUsed = second.model || modelUsed;
        } catch (error) {
          result.validation.warnings.push(
            `A second search for missing balance-sheet / cash-flow values failed (${error.message}); remaining gaps stay N/A.`
          );
        }
      }
    }

    return { ...result, model: modelUsed };
  } finally {
    await cleanup();
  }
}

// ==== PURE:END


/* ============================================================
   5. PDF PRE-CHECK (pdf-parse)
   ============================================================ */

async function sampleTextLength(buffer) {
  try {
    const parsed = await pdfParse(buffer, { max: 12 });

    return {
      pages: parsed.numpages || null,
      characters: String(parsed.text || "").replace(/\s+/g, "").length
    };
  } catch {
    return { pages: null, characters: null };
  }
}


/* ============================================================
   6. EXPRESS APP
   ============================================================ */

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  );
  next();
});

app.use(express.json({ limit: "32kb" }));
app.use(attachSession);


/* ---------- Static frontend (explicit files only) ---------- */

const FRONTEND_FILES = {
  "/": "finsight-investor.html",
  "/finsight-investor.html": "finsight-investor.html",
  "/finsight-investor.css": "finsight-investor.css",
  "/finsight-investor.js": "finsight-investor.js"
};

for (const [route, file] of Object.entries(FRONTEND_FILES)) {
  app.get(route, (_req, res, next) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file, { root: __dirname }, error => {
      if (error) {
        next(error);
      }
    });
  });
}


/* ---------- Health ---------- */

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    gemini: Boolean(GEMINI_API_KEY),
    database: databaseReady
  });
});


/* ---------- Session ---------- */

app.get("/api/session", (req, res) => {
  res.json({
    ok: true,
    authenticated: Boolean(req.session),
    name: req.session?.name || null,
    admin: Boolean(req.session?.admin)
  });
});

app.post("/api/login", async (req, res) => {
  const name = cleanName(req.body?.name);
  const password = String(req.body?.password ?? "");

  if (!SITE_PASSWORD) {
    return res.status(503).json({
      ok: false,
      error: "Login is not configured on the server (FINSIGHT_PASSWORD is missing)."
    });
  }

  if (!name) {
    return res.status(400).json({ ok: false, error: "Please enter your name." });
  }

  if (loginBlocked(req.ip)) {
    return res.status(429).json({
      ok: false,
      error: "Too many failed attempts. Please wait a few minutes and try again."
    });
  }

  const isAdmin = Boolean(ADMIN_PASSWORD) && safeEqual(password, ADMIN_PASSWORD);
  const isUser = safeEqual(password, SITE_PASSWORD);

  if (!isAdmin && !isUser) {
    recordLoginFailure(req.ip);

    await logEvent({
      username: name,
      eventType: "login",
      status: "failed",
      errorMessage: "Incorrect password"
    });

    return res.status(401).json({ ok: false, error: "Incorrect password." });
  }

  loginFailures.delete(req.ip);
  setSessionCookie(res, createSessionToken(name, isAdmin));

  await logEvent({ username: name, eventType: "login", status: "success" });

  res.json({ ok: true, name, admin: isAdmin });
});

app.post("/api/logout", async (req, res) => {
  if (req.session) {
    await logEvent({
      username: req.session.name,
      eventType: "logout",
      status: "success"
    });
  }

  clearSessionCookie(res);
  res.json({ ok: true });
});


/* ---------- Extraction ---------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, callback) {
    const isPdf =
      file.mimetype === "application/pdf" ||
      /\.pdf$/i.test(file.originalname || "");

    if (!isPdf) {
      const error = new Error("Only PDF files are accepted.");
      error.status = 400;
      return callback(error);
    }

    callback(null, true);
  }
});

function receiveReport(req, res, next) {
  upload.single("report")(req, res, error => (error ? next(error) : next()));
}

function decodeFilename(name) {
  const original = String(name || "report.pdf");

  try {
    // multer decodes multipart filenames as latin1
    const decoded = Buffer.from(original, "latin1").toString("utf8");
    return decoded.includes("�") ? original : decoded;
  } catch {
    return original;
  }
}

let activeExtractions = 0;

app.post(
  "/api/ai/extract-financials",
  requireAuth,
  receiveReport,
  async (req, res) => {
    const username = req.session.name;

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No PDF received. Upload a PDF in the \"report\" field."
      });
    }

    const filename = decodeFilename(req.file.originalname)
      .split(/[\\/]/)
      .pop();

    const buffer = req.file.buffer;

    if (buffer.length < 5 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      await logEvent({
        username,
        eventType: "extraction_failed",
        filename,
        status: "failed",
        errorMessage: "File is not a valid PDF."
      });

      return res.status(400).json({
        ok: false,
        error: "The uploaded file is not a valid PDF."
      });
    }

    await logEvent({ username, eventType: "pdf_upload", filename, status: "accepted" });

    const fail = async (httpStatus, message, model = null) => {
      await logEvent({
        username,
        eventType: "extraction_failed",
        filename,
        status: "failed",
        geminiModel: model,
        errorMessage: message
      });

      return res.status(httpStatus).json({ ok: false, error: message });
    };

    if (!GEMINI_API_KEY) {
      return fail(503, "Gemini API key is not configured.");
    }

    if (activeExtractions >= MAX_CONCURRENT_EXTRACTIONS) {
      return fail(503, "FinSight is busy with other extractions. Please try again in a minute.");
    }

    await logEvent({
      username,
      eventType: "extraction_started",
      filename,
      status: "started",
      geminiModel: GEMINI_MODEL
    });

    activeExtractions += 1;

    try {
      const sample = await sampleTextLength(buffer);
      const result = await extractFinancials(buffer);

      if (!result.financials.length) {
        const scanned =
          sample.characters !== null && sample.characters < 200
            ? " The PDF contains insufficient extractable text (it may be a scan)."
            : "";

        return fail(
          422,
          `No financial-year rows were extracted from this report.${scanned} Make sure it contains audited financial statements.`,
          result.model
        );
      }

      if (sample.characters !== null && sample.characters < 200) {
        result.validation.warnings.unshift(
          "The PDF has very little extractable text; values were read visually and should be double-checked."
        );
      }

      const latest = result.financials[result.financials.length - 1];

      await logEvent({
        username,
        eventType: "extraction_success",
        filename,
        company: result.company.name,
        reportYear: latest.year,
        status: "success",
        geminiModel: result.model
      });

      res.json({
        ok: true,
        company: result.company,
        financials: result.financials,
        validation: result.validation,
        provider: "gemini",
        model: result.model
      });
    } catch (error) {
      const known =
        error instanceof GeminiError || error instanceof ExtractionError;

      if (!known) {
        console.error("Extraction crashed:", error);
      }

      await fail(
        known ? error.httpStatus : 500,
        known ? error.message : "Extraction failed unexpectedly. Please try again."
      );
    } finally {
      activeExtractions -= 1;
    }
  }
);


/* ---------- Admin: usage history as Excel ---------- */

function formatDateParts(date) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: USAGE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);

  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: USAGE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);

  return { day, time };
}

app.get("/api/admin/usage.xlsx", requireAdmin, async (_req, res) => {
  if (!pool) {
    return res.status(503).json({
      ok: false,
      error: "Database connection failed: DATABASE_URL is not configured."
    });
  }

  try {
    if (!databaseReady) {
      await initDatabase();
    }

    if (!databaseReady) {
      return res.status(503).json({
        ok: false,
        error: "Database connection failed. Check DATABASE_URL and DATABASE_SSL."
      });
    }

    const { rows } = await pool.query(
      `SELECT event_id, username, event_type, filename, company,
              report_year, status, gemini_model, error_message, created_at
         FROM usage_events
        ORDER BY created_at ASC, event_id ASC`
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "FinSight";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Usage Log", {
      views: [{ state: "frozen", ySplit: 1 }]
    });

    sheet.columns = [
      { header: "Event ID", key: "event_id", width: 38 },
      { header: "User", key: "username", width: 22 },
      { header: "Event Type", key: "event_type", width: 20 },
      { header: "File Name", key: "filename", width: 40 },
      { header: "Company", key: "company", width: 30 },
      { header: "Report Year", key: "report_year", width: 13 },
      { header: "Status", key: "status", width: 12 },
      { header: "Gemini Model", key: "gemini_model", width: 22 },
      { header: "Date", key: "date", width: 13 },
      { header: "Time", key: "time", width: 11 },
      { header: "Error", key: "error", width: 60 }
    ];

    for (const row of rows) {
      const { day, time } = formatDateParts(new Date(row.created_at));

      sheet.addRow({
        event_id: row.event_id,
        username: row.username,
        event_type: row.event_type,
        filename: row.filename ?? "",
        company: row.company ?? "",
        report_year: row.report_year ?? "",
        status: row.status ?? "",
        gemini_model: row.gemini_model ?? "",
        date: day,
        time,
        error: row.error_message ?? ""
      });
    }

    const header = sheet.getRow(1);

    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0E4B3E" }
    };

    sheet.autoFilter = { from: "A1", to: "K1" };

    const buffer = await workbook.xlsx.writeBuffer();
    const stamp = formatDateParts(new Date()).day;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="finsight-usage-${stamp}.xlsx"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(Buffer.from(buffer));
  } catch (error) {
    console.error("Usage export failed:", error.message);

    res.status(500).json({
      ok: false,
      error: "Could not generate the usage workbook. Check the database connection."
    });
  }
});


/* ---------- Not found / errors ---------- */

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: "Not found." });
  }

  res.status(404).type("text/plain").send("Not found.");
});

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "PDF exceeds 45 MB."
        : error.code === "LIMIT_UNEXPECTED_FILE"
          ? "Upload the PDF in the \"report\" field."
          : "Upload failed. Please try again with a single PDF.";

    return res
      .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({ ok: false, error: message });
  }

  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid request body." });
  }

  if (error?.status && error.status < 500) {
    return res.status(error.status).json({ ok: false, error: error.message });
  }

  console.error("Unhandled error:", error?.message || error);

  res.status(500).json({
    ok: false,
    error: "Something went wrong on the server."
  });
});

process.on("unhandledRejection", reason => {
  console.error("Unhandled rejection:", reason?.message || reason);
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error?.message || error);
});


/* ============================================================
   7. START
   ============================================================ */

async function start() {
  console.log("Starting FinSight...");
  console.log(`Gemini configured: ${Boolean(GEMINI_API_KEY)}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log(`Database configured: ${databaseEnabled}`);

  if (!SITE_PASSWORD) {
    console.warn("FINSIGHT_PASSWORD is not set. Login is disabled.");
  }

  if (sessionSecretIsEphemeral) {
    console.warn("SESSION_SECRET is not set. Sessions will reset on every restart.");
  }

  await initDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log("FinSight server started.");
    console.log(`Port: ${PORT}`);
  });
}

start().catch(error => {
  console.error("FinSight startup failed:", error?.message || error);
  process.exit(1);
});
