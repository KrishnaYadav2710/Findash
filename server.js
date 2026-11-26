/*
 * ============================================================
 * FINSIGHT AI - SERVER
 * Simplified Gemini-only extraction + usage logging
 *
 * Features:
 * - Serves the FinSight dashboard
 * - User login/name registration endpoint
 * - Gemini-only annual-report PDF extraction
 * - Normalizes Gemini JSON for the dashboard
 * - Excel usage log
 * - Optional Supabase persistent usage log
 * - Health endpoint
 *
 * Required environment variables:
 *   GEMINI_API_KEY=...
 *
 * Optional:
 *   GEMINI_MODEL=gemini-2.5-flash
 *   PORT=3000
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *
 * Install:
 *   npm install express multer dotenv exceljs
 *
 * package.json should contain:
 *   "type": "module"
 * ============================================================
 */

import "dotenv/config";

import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";


/* ============================================================
   1. BASIC SETUP
   ============================================================ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);

const GEMINI_API_KEY =
  String(process.env.GEMINI_API_KEY || "").trim();

const GEMINI_MODEL =
  String(
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash"
  ).trim();

const SUPABASE_URL =
  String(process.env.SUPABASE_URL || "")
    .trim()
    .replace(/\/+$/, "");

const SUPABASE_SERVICE_ROLE_KEY =
  String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  ).trim();

const MAX_PDF_SIZE =
  45 * 1024 * 1024;

const GEMINI_TIMEOUT_MS =
  Math.max(
    30000,
    Math.min(
      Number(
        process.env.GEMINI_TIMEOUT_MS ||
        240000
      ),
      300000
    )
  );

const LOG_FILE =
  path.join(
    __dirname,
    "finsight-usage-log.xlsx"
  );


/* ============================================================
   2. EXPRESS
   ============================================================ */

app.use(
  express.json({
    limit: "5mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "5mb"
  })
);

app.use(
  express.static(__dirname)
);


/* ============================================================
   3. PDF UPLOAD
   ============================================================ */

const upload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      fileSize:
        MAX_PDF_SIZE
    },

    fileFilter: (
      req,
      file,
      callback
    ) => {

      const mime =
        String(
          file?.mimetype || ""
        ).toLowerCase();

      if (
        mime &&
        mime !== "application/pdf"
      ) {

        const error =
          new Error(
            "Only PDF annual reports are accepted."
          );

        error.status = 400;

        return callback(
          error
        );
      }

      callback(
        null,
        true
      );
    }
  });


function validatePdf(file) {

  if (
    !file ||
    !Buffer.isBuffer(file.buffer) ||
    !file.buffer.length
  ) {

    const error =
      new Error(
        "The uploaded PDF is empty."
      );

    error.status = 400;

    throw error;
  }

  const signature =
    file.buffer
      .subarray(0, 5)
      .toString("ascii");

  if (
    signature !== "%PDF-"
  ) {

    const error =
      new Error(
        "The uploaded file is not a valid PDF."
      );

    error.status = 400;

    throw error;
  }
}


/* ============================================================
   4. GENERAL HELPERS
   ============================================================ */

function cleanText(
  value,
  maxLength = 500
) {

  return String(
    value ?? ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}


function finiteNumber(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (
    typeof value === "number"
  ) {

    return Number.isFinite(value)
      ? value
      : null;
  }

  let text =
    String(value)
      .trim()
      .replace(/₹/g, "")
      .replace(/\bINR\b/gi, "")
      .replace(/\bRs\.?\b/gi, "")
      .replace(/,/g, "");

  let negative = false;

  if (
    /^\(.*\)$/.test(text)
  ) {

    negative = true;

    text =
      text.slice(1, -1);
  }

  if (
    !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(
      text
    )
  ) {
    return null;
  }

  const number =
    Number(text);

  if (
    !Number.isFinite(number)
  ) {
    return null;
  }

  return negative
    ? -Math.abs(number)
    : number;
}


function roundFinancial(value) {

  const number =
    finiteNumber(value);

  if (number === null) {
    return null;
  }

  return Math.round(
    number * 100
  ) / 100;
}


function safeRatio(
  numerator,
  denominator,
  multiplier = 1
) {

  const a =
    finiteNumber(numerator);

  const b =
    finiteNumber(denominator);

  if (
    a === null ||
    b === null ||
    Math.abs(b) < 0.0000001
  ) {
    return null;
  }

  return roundFinancial(
    (a / b) *
    multiplier
  );
}


function financialYearLabel(year) {

  const value =
    Number(year);

  if (
    !Number.isInteger(value)
  ) {
    return null;
  }

  return (
    `FY${value - 1}-` +
    String(value).slice(-2)
  );
}


function safeJSON(value) {

  if (
    value &&
    typeof value === "object"
  ) {
    return value;
  }

  const source =
    String(value || "")
      .trim();

  if (!source) {
    return null;
  }

  const cleaned =
    source
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}


function clientIp(req) {

  const forwarded =
    String(
      req.headers[
        "x-forwarded-for"
      ] || ""
    )
      .split(",")[0]
      .trim();

  return (
    forwarded ||
    req.socket?.remoteAddress ||
    ""
  );
}


/* ============================================================
   5. EXCEL LOG
   ============================================================ */

const EXCEL_HEADERS = [
  "Date",
  "Time",
  "User Name",
  "Action",
  "File Name",
  "Company",
  "Status",
  "Provider",
  "Model",
  "IP Address"
];


async function ensureExcelLog() {

  const workbook =
    new ExcelJS.Workbook();

  try {

    await workbook.xlsx.readFile(
      LOG_FILE
    );

    if (
      workbook.getWorksheet(
        "Usage Log"
      )
    ) {
      return;
    }

  } catch {
    // Create a new workbook.
  }

  const sheet =
    workbook.addWorksheet(
      "Usage Log"
    );

  sheet.addRow(
    EXCEL_HEADERS
  );

  sheet.getRow(1).font = {
    bold: true
  };

  sheet.views = [
    {
      state: "frozen",
      ySplit: 1
    }
  ];

  sheet.columns = [
    { width: 14 },
    { width: 12 },
    { width: 24 },
    { width: 20 },
    { width: 42 },
    { width: 35 },
    { width: 15 },
    { width: 14 },
    { width: 25 },
    { width: 24 }
  ];

  await workbook.xlsx.writeFile(
    LOG_FILE
  );
}


async function appendExcelLog({
  userName = "",
  action = "",
  fileName = "",
  company = "",
  status = "",
  provider = "",
  model = "",
  ipAddress = ""
}) {

  try {

    await ensureExcelLog();

    const workbook =
      new ExcelJS.Workbook();

    await workbook.xlsx.readFile(
      LOG_FILE
    );

    const sheet =
      workbook.getWorksheet(
        "Usage Log"
      );

    const now =
      new Date();

    const date =
      now.toLocaleDateString(
        "en-IN",
        {
          timeZone:
            "Asia/Kolkata"
        }
      );

    const time =
      now.toLocaleTimeString(
        "en-IN",
        {
          timeZone:
            "Asia/Kolkata"
        }
      );

    sheet.addRow([
      date,
      time,
      cleanText(userName, 200),
      cleanText(action, 100),
      cleanText(fileName, 500),
      cleanText(company, 500),
      cleanText(status, 100),
      cleanText(provider, 100),
      cleanText(model, 200),
      cleanText(ipAddress, 200)
    ]);

    await workbook.xlsx.writeFile(
      LOG_FILE
    );

  } catch (error) {

    console.error(
      "Excel log error:",
      error
    );
  }
}


/* ============================================================
   6. SUPABASE LOG
   ============================================================ */

/*
 * Create this table in Supabase:
 *
 * create table public.usage_logs (
 *   id bigint generated by default as identity primary key,
 *   created_at timestamptz not null default now(),
 *   user_name text,
 *   action text,
 *   file_name text,
 *   company text,
 *   status text,
 *   provider text,
 *   model text,
 *   ip_address text
 * );
 */

function supabaseConfigured() {

  return Boolean(
    SUPABASE_URL &&
    SUPABASE_SERVICE_ROLE_KEY
  );
}


async function appendSupabaseLog({
  userName = "",
  action = "",
  fileName = "",
  company = "",
  status = "",
  provider = "",
  model = "",
  ipAddress = ""
}) {

  if (
    !supabaseConfigured()
  ) {
    return;
  }

  try {

    const response =
      await fetch(
        `${SUPABASE_URL}/rest/v1/usage_logs`,
        {
          method: "POST",

          headers: {
            apikey:
              SUPABASE_SERVICE_ROLE_KEY,

            Authorization:
              `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

            "Content-Type":
              "application/json",

            Prefer:
              "return=minimal"
          },

          body:
            JSON.stringify({
              user_name:
                cleanText(userName, 200),

              action:
                cleanText(action, 100),

              file_name:
                cleanText(fileName, 500),

              company:
                cleanText(company, 500),

              status:
                cleanText(status, 100),

              provider:
                cleanText(provider, 100),

              model:
                cleanText(model, 200),

              ip_address:
                cleanText(ipAddress, 200)
            })
        }
      );

    if (!response.ok) {

      const message =
        await response.text();

      console.error(
        "Supabase log failed:",
        response.status,
        message
      );
    }

  } catch (error) {

    console.error(
      "Supabase log error:",
      error
    );
  }
}


async function writeUsageLog(data) {

  await Promise.allSettled([
    appendExcelLog(data),
    appendSupabaseLog(data)
  ]);
}


/* ============================================================
   7. GEMINI
   ============================================================ */

function geminiUrl() {

  return (
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(
      GEMINI_MODEL
    ) +
    ":generateContent"
  );
}


function extractGeminiText(payload) {

  return (
    payload
      ?.candidates
      ?.[0]
      ?.content
      ?.parts ||
    []
  )
    .map(
      part =>
        part?.text || ""
    )
    .join("\n")
    .trim();
}


function buildExtractionPrompt() {

  return `
You are the financial-statement extraction engine for FinSight.

Read the attached annual-report PDF and return ONLY valid JSON.

IMPORTANT RULES
- Prefer CONSOLIDATED audited financial statements.
- Use standalone only when consolidated statements do not exist.
- Never mix consolidated and standalone figures in one year.
- Extract the latest year and comparative years that are clearly supported.
- Never guess.
- Missing or uncertain values MUST be null, never zero.
- Monetary values must be returned exactly in the source statement unit.
- Do not convert monetary units yourself.
- Revenue means revenue from operations / operating revenue, not total income.
- operating_income means EBIT / operating profit.
- EBITDA must be an explicitly reported EBITDA value. If it is not explicitly reported, return null.
- total_debt should include interest-bearing borrowings. Do not silently include trade payables.
- cash means cash and cash equivalents.
- capex should be the cash outflow for purchases/additions of PPE/intangibles when reliably identifiable.
- shares_outstanding means period-end equity shares, NOT weighted-average EPS shares.
- Do not infer ticker/exchange/listing status unless clearly disclosed.
- Use null whenever a field cannot be established reliably.
- JSON only. No Markdown.

RETURN THIS EXACT ROOT SHAPE

{
  "company": {
    "name": "",
    "legal_name": "",
    "listing_status": "listed|unlisted|pre-IPO|proposed listing|unknown",
    "ticker": null,
    "exchange": null,
    "isin": null,
    "currency": "₹"
  },
  "financials": [
    {
      "financial_year": "",
      "year": null,
      "statement_basis": "Consolidated|Standalone",
      "source_unit": "INR crore|INR million|INR lakh|INR billion",
      "revenue": null,
      "ebitda": null,
      "operating_income": null,
      "net_income": null,
      "total_assets": null,
      "current_assets": null,
      "current_liabilities": null,
      "total_debt": null,
      "cash": null,
      "total_equity": null,
      "operating_cash_flow": null,
      "capex": null,
      "inventory": null,
      "accounts_receivable": null,
      "accounts_payable": null,
      "finance_cost": null,
      "shares_outstanding": null,
      "shares_outstanding_unit": "shares|crore shares|lakh shares|million shares|billion shares"
    }
  ],
  "warnings": []
}
`.trim();
}


async function callGeminiForPdf(
  file
) {

  if (!GEMINI_API_KEY) {

    const error =
      new Error(
        "Gemini API key is not configured."
      );

    error.status = 503;

    throw error;
  }

  validatePdf(file);

  const body = {
    system_instruction: {
      parts: [
        {
          text:
            "Extract audited financial statement data accurately. Never invent missing values. Return JSON only."
        }
      ]
    },

    contents: [
      {
        role: "user",

        parts: [
          {
            text:
              buildExtractionPrompt()
          },

          {
            inlineData: {
              mimeType:
                "application/pdf",

              data:
                file.buffer.toString(
                  "base64"
                )
            }
          }
        ]
      }
    ],

    generationConfig: {
      temperature: 0,
      responseMimeType:
        "application/json"
    }
  };

  let response;

  try {

    response =
      await fetch(
        geminiUrl(),
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              GEMINI_API_KEY
          },

          body:
            JSON.stringify(body),

          signal:
            AbortSignal.timeout(
              GEMINI_TIMEOUT_MS
            )
        }
      );

  } catch (error) {

    if (
      error?.name ===
        "TimeoutError" ||
      error?.name ===
        "AbortError"
    ) {

      const timeoutError =
        new Error(
          "Gemini extraction timed out. Please try the report again."
        );

      timeoutError.status = 504;

      throw timeoutError;
    }

    throw error;
  }

  const text =
    await response.text();

  let payload = {};

  try {
    payload =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    payload = {
      raw: text
    };
  }

  if (!response.ok) {

    const providerMessage =
      payload?.error?.message ||
      payload?.message ||
      payload?.raw ||
      `Gemini HTTP ${response.status}`;

    const error =
      new Error(
        String(providerMessage)
      );

    error.status =
      response.status;

    throw error;
  }

  const modelText =
    extractGeminiText(
      payload
    );

  if (!modelText) {

    const error =
      new Error(
        "Gemini returned no extraction data."
      );

    error.status = 502;

    throw error;
  }

  console.log(
    "Gemini raw financial JSON:",
    modelText.slice(0, 12000)
  );

  let result =
    safeJSON(modelText);

  /*
   * Some Gemini responses wrap the root object
   * in a one-element array.
   */
  if (
    Array.isArray(result) &&
    result.length === 1 &&
    result[0] &&
    typeof result[0] === "object"
  ) {

    result =
      result[0];
  }

  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {

    const error =
      new Error(
        "Gemini returned invalid JSON."
      );

    error.status = 502;

    throw error;
  }

  return result;
}


/* ============================================================
   8. GEMINI -> DASHBOARD NORMALIZATION
   ============================================================ */

function monetaryFactor(unit) {

  const value =
    String(unit || "")
      .toLowerCase()
      .trim();

  if (
    value.includes("crore")
  ) {
    return 1;
  }

  if (
    value.includes("million")
  ) {
    return 0.1;
  }

  if (
    value.includes("lakh")
  ) {
    return 0.01;
  }

  if (
    value.includes("billion")
  ) {
    return 100;
  }

  return null;
}


function normalizeShares(
  value,
  unit
) {

  const number =
    finiteNumber(value);

  if (
    number === null ||
    number <= 0
  ) {
    return null;
  }

  const normalized =
    String(unit || "")
      .toLowerCase()
      .trim();

  if (
    normalized.includes(
      "crore"
    )
  ) {
    return roundFinancial(number);
  }

  if (
    normalized.includes(
      "lakh"
    )
  ) {
    return roundFinancial(
      number / 100
    );
  }

  if (
    normalized.includes(
      "million"
    )
  ) {
    return roundFinancial(
      number / 10
    );
  }

  if (
    normalized.includes(
      "billion"
    )
  ) {
    return roundFinancial(
      number * 100
    );
  }

  if (
    normalized === "shares" ||
    normalized === "share" ||
    normalized.includes(
      "absolute"
    )
  ) {
    return roundFinancial(
      number / 10000000
    );
  }

  return null;
}


function normalizeGeminiExtraction(
  raw
) {

  if (
    !Array.isArray(
      raw?.financials
    )
  ) {

    const error =
      new Error(
        "Gemini JSON does not contain a financials array."
      );

    error.status = 502;

    throw error;
  }

  const monetaryFields = [
    "revenue",
    "ebitda",
    "operating_income",
    "net_income",
    "total_assets",
    "current_assets",
    "current_liabilities",
    "total_debt",
    "cash",
    "total_equity",
    "operating_cash_flow",
    "capex",
    "inventory",
    "accounts_receivable",
    "accounts_payable",
    "finance_cost"
  ];

  const rows = [];

  for (
    const source
    of raw.financials
  ) {

    if (
      !source ||
      typeof source !== "object"
    ) {
      continue;
    }

    const year =
      Number(source.year);

    if (
      !Number.isInteger(year) ||
      year < 1990 ||
      year > 2100
    ) {
      continue;
    }

    const factor =
      monetaryFactor(
        source.source_unit
      );

    if (
      factor === null
    ) {

      console.warn(
        "Skipping Gemini row because source unit is unknown:",
        source.source_unit
      );

      continue;
    }

    const row = {
      company:
        source.company ||
        raw?.company?.name ||
        raw?.company?.legal_name ||
        null,

      financial_year:
        cleanText(
          source.financial_year ||
          financialYearLabel(year),
          50
        ),

      year,

      statement_basis:
        cleanText(
          source.statement_basis ||
          "Unknown",
          50
        ),

      source_unit:
        "INR crore",

      original_source_unit:
        source.source_unit ||
        null,

      source_pages: [],

      extraction_notes:
        "Extracted by Gemini from the uploaded annual report and normalized by FinSight."
    };

    for (
      const field
      of monetaryFields
    ) {

      const rawValue =
        finiteNumber(
          source[field]
        );

      row[field] =
        rawValue === null
          ? null
          : roundFinancial(
              rawValue * factor
            );
    }

    if (
      row.capex !== null
    ) {
      row.capex =
        Math.abs(row.capex);
    }

    if (
      row.finance_cost !== null
    ) {
      row.finance_cost =
        Math.abs(
          row.finance_cost
        );
    }

    if (
      row.total_debt !== null &&
      row.total_debt < 0
    ) {
      row.total_debt = null;
    }

    row.shares_outstanding =
      normalizeShares(
        source.shares_outstanding,
        source.shares_outstanding_unit
      );

    row.shares_outstanding_unit =
      row.shares_outstanding === null
        ? null
        : "crore shares";

    /*
     * Dashboard calculations.
     * Server values are percentages where noted.
     */
    row.ebitda_margin =
      safeRatio(
        row.ebitda,
        row.revenue,
        100
      );

    row.operating_margin =
      safeRatio(
        row.operating_income,
        row.revenue,
        100
      );

    row.net_margin =
      safeRatio(
        row.net_income,
        row.revenue,
        100
      );

    row.current_ratio =
      safeRatio(
        row.current_assets,
        row.current_liabilities
      );

    row.debt_equity =
      safeRatio(
        row.total_debt,
        row.total_equity
      );

    row.net_debt =
      row.total_debt !== null &&
      row.cash !== null
        ? roundFinancial(
            row.total_debt -
            row.cash
          )
        : null;

    row.free_cash_flow =
      row.operating_cash_flow !== null &&
      row.capex !== null
        ? roundFinancial(
            row.operating_cash_flow -
            row.capex
          )
        : null;

    row.simplified_fcf =
      row.free_cash_flow;

    row.cash_conversion =
      safeRatio(
        row.operating_cash_flow,
        row.net_income
      );

    row.interest_coverage =
      safeRatio(
        row.operating_income,
        row.finance_cost
      );

    /*
     * These require average balances and are
     * calculated after sorting the years.
     */
    row.roe = null;
    row.roa = null;
    row.roce = null;
    row.asset_turnover = null;
    row.receivable_days = null;

    rows.push(row);
  }

  if (!rows.length) {

    const error =
      new Error(
        "Gemini returned no financial rows that FinSight could safely normalize."
      );

    error.status = 502;

    throw error;
  }

  /*
   * Oldest -> newest for average-balance metrics.
   */
  rows.sort(
    (a, b) =>
      a.year - b.year
  );

  for (
    let index = 0;
    index < rows.length;
    index++
  ) {

    const current =
      rows[index];

    const previous =
      index > 0 &&
      rows[index - 1].year ===
        current.year - 1
        ? rows[index - 1]
        : null;

    /*
     * Receivable days:
     * Receivables / Revenue x 365
     */
    current.receivable_days =
      current.accounts_receivable !== null &&
      current.revenue !== null &&
      current.revenue > 0
        ? safeRatio(
            current.accounts_receivable,
            current.revenue,
            365
          )
        : null;

    if (!previous) {
      continue;
    }

    /*
     * ROE:
     * Net income / Average equity
     */
    if (
      current.net_income !== null &&
      current.total_equity !== null &&
      previous.total_equity !== null
    ) {

      const averageEquity =
        (
          current.total_equity +
          previous.total_equity
        ) / 2;

      current.roe =
        averageEquity > 0
          ? safeRatio(
              current.net_income,
              averageEquity,
              100
            )
          : null;
    }

    /*
     * ROA:
     * Net income / Average assets
     */
    if (
      current.net_income !== null &&
      current.total_assets !== null &&
      previous.total_assets !== null
    ) {

      const averageAssets =
        (
          current.total_assets +
          previous.total_assets
        ) / 2;

      current.roa =
        averageAssets > 0
          ? safeRatio(
              current.net_income,
              averageAssets,
              100
            )
          : null;

      current.asset_turnover =
        averageAssets > 0
          ? safeRatio(
              current.revenue,
              averageAssets
            )
          : null;
    }

    /*
     * ROCE:
     * EBIT / Average capital employed
     *
     * Capital employed =
     * Total assets - current liabilities
     */
    if (
      current.operating_income !== null &&
      current.total_assets !== null &&
      current.current_liabilities !== null &&
      previous.total_assets !== null &&
      previous.current_liabilities !== null
    ) {

      const currentCapital =
        current.total_assets -
        current.current_liabilities;

      const previousCapital =
        previous.total_assets -
        previous.current_liabilities;

      const averageCapital =
        (
          currentCapital +
          previousCapital
        ) / 2;

      current.roce =
        averageCapital > 0
          ? safeRatio(
              current.operating_income,
              averageCapital,
              100
            )
          : null;
    }
  }

  /*
   * Dashboard expects newest first from server.
   */
  rows.sort(
    (a, b) =>
      b.year - a.year
  );

  const company =
    raw?.company &&
    typeof raw.company === "object"
      ? {
          ...raw.company
        }
      : {};

  company.name =
    cleanText(
      company.name ||
      company.legal_name ||
      rows[0]?.company ||
      "Unknown company",
      500
    );

  company.legal_name =
    cleanText(
      company.legal_name ||
      company.name,
      500
    );

  company.listing_status =
    [
      "listed",
      "unlisted",
      "pre-IPO",
      "proposed listing",
      "unknown"
    ].includes(
      company.listing_status
    )
      ? company.listing_status
      : "unknown";

  company.ticker =
    company.ticker ||
    null;

  company.exchange =
    company.exchange ||
    null;

  company.isin =
    company.isin ||
    null;

  company.currency =
    company.currency ||
    "₹";

  company.extraction_confidence =
    "Gemini extracted";

  const criticalFields = [
    "revenue",
    "net_income",
    "total_assets",
    "total_equity",
    "operating_cash_flow"
  ];

  const latest =
    rows[0];

  const missingCriticalFields =
    criticalFields.filter(
      field =>
        latest[field] === null
    );

  const warnings =
    Array.isArray(raw?.warnings)
      ? raw.warnings
          .map(
            value =>
              cleanText(value, 1000)
          )
          .filter(Boolean)
      : [];

  if (
    missingCriticalFields.length
  ) {

    warnings.push(
      "Some dashboard fields are N/A because Gemini could not establish them reliably from the annual report."
    );
  }

  return {
    company,

    financials:
      rows,

    validation: {
      consolidated_preferred: true,

      years_found:
        rows.map(
          row =>
            row.financial_year
        ),

      missing_critical_fields:
        missingCriticalFields,

      warnings
    }
  };
}


/* ============================================================
   9. HEALTH
   ============================================================ */

app.get(
  "/healthz",
  (req, res) => {

    res
      .status(200)
      .send("ok");
  }
);


app.get(
  "/api/health",
  (req, res) => {

    res.json({
      ok: true,

      aiConfigured:
        Boolean(
          GEMINI_API_KEY
        ),

      aiProvider:
        "gemini",

      model:
        GEMINI_MODEL,

      extraction:
        "gemini-only",

      maxPdfSizeMB:
        45,

      excelLogging:
        true,

      supabaseLogging:
        supabaseConfigured()
    });
  }
);


/* ============================================================
   10. LOGIN / USER ENTRY LOG
   ============================================================ */

/*
 * Frontend can POST:
 *
 * {
 *   "name": "User name"
 * }
 *
 * Password authentication should not be stored in Excel.
 * Never log plaintext passwords.
 */

app.post(
  "/api/login",
  async (req, res) => {

    const name =
      cleanText(
        req.body?.name,
        200
      );

    if (!name) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Name is required."
        });
    }

    await writeUsageLog({
      userName:
        name,

      action:
        "login",

      status:
        "success",

      provider:
        "FinSight",

      ipAddress:
        clientIp(req)
    });

    return res.json({
      ok: true,
      name
    });
  }
);


/* ============================================================
   11. GEMINI FINANCIAL EXTRACTION
   ============================================================ */

app.post(
  "/api/ai/extract-financials",

  upload.single("report"),

  async (req, res) => {

    const userName =
      cleanText(
        req.body?.userName ||
        req.body?.name ||
        "Anonymous",
        200
      );

    const fileName =
      cleanText(
        req.file?.originalname ||
        "",
        500
      );

    try {

      if (!req.file) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Upload an annual-report PDF.",
            code:
              "REPORT_REQUIRED"
          });
      }

      validatePdf(
        req.file
      );

      const sourceHash =
        crypto
          .createHash("sha256")
          .update(req.file.buffer)
          .digest("hex");

      console.log(
        "Gemini extraction started:",
        {
          userName,
          fileName,
          sizeMB:
            roundFinancial(
              req.file.buffer.length /
              1024 /
              1024
            ),
          model:
            GEMINI_MODEL,
          sourceHash:
            sourceHash.slice(0, 12)
        }
      );

      const raw =
        await callGeminiForPdf(
          req.file
        );

      const result =
        normalizeGeminiExtraction(
          raw
        );

      console.log(
        "Gemini normalized dashboard data:",
        JSON.stringify(
          {
            company:
              result.company,
            financials:
              result.financials
          },
          null,
          2
        ).slice(0, 16000)
      );

      await writeUsageLog({
        userName,

        action:
          "financial extraction",

        fileName,

        company:
          result.company?.name ||
          "",

        status:
          "success",

        provider:
          "Gemini",

        model:
          GEMINI_MODEL,

        ipAddress:
          clientIp(req)
      });

      return res.json({
        ok: true,

        ...result,

        provider:
          "gemini",

        model:
          GEMINI_MODEL,

        cached:
          false,

        sourceHash:
          sourceHash.slice(0, 16)
      });

    } catch (error) {

      console.error(
        "Gemini extraction failed:",
        error
      );

      await writeUsageLog({
        userName,

        action:
          "financial extraction",

        fileName,

        company: "",

        status:
          `failed: ${
            cleanText(
              error?.message ||
              "unknown error",
              300
            )
          }`,

        provider:
          "Gemini",

        model:
          GEMINI_MODEL,

        ipAddress:
          clientIp(req)
      });

      let status =
        Number(error?.status);

      if (
        !Number.isInteger(status) ||
        status < 400 ||
        status > 599
      ) {
        status = 500;
      }

      let code =
        "GEMINI_EXTRACTION_FAILED";

      if (status === 429) {
        code =
          "GEMINI_RATE_LIMIT";
      }

      if (status === 413) {
        code =
          "REPORT_TOO_LARGE";
      }

      if (status === 400) {
        code =
          "INVALID_REPORT";
      }

      if (
        status === 401 ||
        status === 403
      ) {

        status = 503;

        code =
          "GEMINI_CONFIGURATION_ERROR";
      }

      if (
        status >= 500 &&
        status !== 503
      ) {

        status = 503;
      }

      return res
        .status(status)
        .json({
          ok: false,

          error:
            error?.message ||
            "Gemini could not extract the annual report.",

          code,

          provider:
            "gemini",

          model:
            GEMINI_MODEL
        });
    }
  }
);


/* ============================================================
   12. EXCEL DOWNLOAD
   ============================================================ */

/*
 * This endpoint is intentionally kept separate from the
 * dashboard UI. If you do not want users downloading the log,
 * do NOT add a frontend button pointing to this route.
 *
 * For stronger privacy, remove this endpoint entirely after
 * confirming Supabase logging works.
 */

app.get(
  "/api/admin/usage-log.xlsx",
  async (req, res) => {

    try {

      await ensureExcelLog();

      return res.download(
        LOG_FILE,
        "finsight-usage-log.xlsx"
      );

    } catch (error) {

      console.error(
        "Usage log download:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Could not prepare the usage log."
        });
    }
  }
);


/* ============================================================
   13. HOME
   ============================================================ */

app.get(
  "/",
  (req, res) => {

    return res.sendFile(
      path.join(
        __dirname,
        "finsight-investor.html"
      )
    );
  }
);


/* ============================================================
   14. 404
   ============================================================ */

app.use(
  (req, res) => {

    res
      .status(404)
      .json({
        ok: false,
        error:
          "Route not found.",
        path:
          req.path
      });
  }
);


/* ============================================================
   15. GLOBAL ERROR HANDLER
   ============================================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "Unhandled FinSight error:",
      error
    );

    if (
      error instanceof
      multer.MulterError
    ) {

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return res
          .status(413)
          .json({
            ok: false,
            error:
              "The PDF exceeds the 45 MB upload limit.",
            code:
              "REPORT_TOO_LARGE"
          });
      }

      return res
        .status(400)
        .json({
          ok: false,
          error:
            `File upload error: ${error.message}`,
          code:
            "FILE_UPLOAD_ERROR"
        });
    }

    const status =
      Number.isInteger(
        Number(error?.status)
      )
        ? Number(error.status)
        : 500;

    return res
      .status(
        status >= 400 &&
        status <= 599
          ? status
          : 500
      )
      .json({
        ok: false,
        error:
          error?.message ||
          "Unexpected server error."
      });
  }
);


/* ============================================================
   16. START SERVER
   ============================================================ */

async function boot() {

  try {

    await ensureExcelLog();

    console.log(
      "Excel usage log ready."
    );

  } catch (error) {

    console.error(
      "Excel log initialization failed:",
      error
    );
  }

  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `FinSight running on port ${PORT}`
      );

      console.log(
        `Gemini: ${
          GEMINI_API_KEY
            ? "READY"
            : "NOT CONFIGURED"
        }`
      );

      console.log(
        `Gemini model: ${GEMINI_MODEL}`
      );

      console.log(
        "Financial extraction: GEMINI ONLY"
      );

      console.log(
        "Dashboard normalization: ENABLED"
      );

      console.log(
        "Excel usage logging: ENABLED"
      );

      console.log(
        `Supabase usage logging: ${
          supabaseConfigured()
            ? "ENABLED"
            : "NOT CONFIGURED"
        }`
      );
    }
  );
}


boot();
