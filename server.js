/* ============================================================
   FINSIGHT AI — SERVER
   Report-first investor research backend

   FEATURES
   - Annual-report financial extraction
   - Multi-report / multi-year analysis
   - Report-grounded Ask FinSight
   - Gemini AI
   - Alpha Vantage
   - Automatic valuation support
   - DCF / Reverse DCF
   - PostgreSQL / Supabase research memory
   - Competitor annual-report comparison
   ============================================================ */


import "dotenv/config";

import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import pdfParse from "pdf-parse";
import pg from "pg";
import ExcelJS from "exceljs";


import {
  fileURLToPath
} from "node:url";

import {
  runDCF,
  reverseDCF
} from "./valuation.js";


/* ============================================================
   1. BASIC SETUP
   ============================================================ */

const { Pool } = pg;


const __filename =
  fileURLToPath(
    import.meta.url
  );


const __dirname =
  path.dirname(
    __filename
  );


const app =
  express();


const PORT =
  Number(
    process.env.PORT ||
    10000
  );


const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.1-flash-lite";


const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  "";


const ALPHA_VANTAGE_API_KEY =
  process.env.ALPHA_VANTAGE_API_KEY ||
  "";


const FINSIGHT_USERNAME =
  process.env.FINSIGHT_USERNAME ||
  "";


const FINSIGHT_PASSWORD =
  process.env.FINSIGHT_PASSWORD ||
  process.env.FINSIGHT_ACCESS_PASSWORD ||
  "";

const FINSIGHT_ADMIN_PASSWORD =
  process.env.FINSIGHT_ADMIN_PASSWORD ||
  "";

const sessions = new Map();


/* ============================================================
   2. DATABASE
   ============================================================ */

const databaseEnabled =
  Boolean(
    process.env.DATABASE_URL
  );


const pool =

  databaseEnabled

    ? new Pool({

        connectionString:
          process.env.DATABASE_URL,

        ssl:

          process.env.DATABASE_SSL ===
          "false"

            ? false

            : {
                rejectUnauthorized:
                  false
              },

        max:
          Number(
            process.env
              .DATABASE_POOL_MAX ||
            5
          )

      })

    : null;


if (pool) {

  pool.on(
    "error",
    error => {

      console.error(
        "PostgreSQL pool error:",
        error
      );

    }
  );

}


async function dbQuery(
  text,
  params = []
) {

  if (!pool) {

    throw new Error(
      "Database is not configured."
    );

  }


  return pool.query(
    text,
    params
  );

}


/* ============================================================
   3. DATABASE INITIALIZATION
   ============================================================ */

async function initDatabase() {

  if (!pool) {
    return;
  }


  const statements = [

    `
    CREATE TABLE IF NOT EXISTS companies (

      id BIGSERIAL PRIMARY KEY,

      name TEXT NOT NULL,

      ticker TEXT,

      exchange TEXT,

      sector TEXT,

      listing_status TEXT,

      isin TEXT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      UNIQUE (ticker, exchange)

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS reports (

      id BIGSERIAL PRIMARY KEY,

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

      filename TEXT NOT NULL,

      report_year INTEGER,

      metrics JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      analysis JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      source_hash TEXT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS research_theses (

      id BIGSERIAL PRIMARY KEY,

      company_id TEXT NOT NULL,

      thesis TEXT NOT NULL,

      bull_case TEXT,

      bear_case TEXT,

      thesis_breakers JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      status TEXT
        NOT NULL
        DEFAULT 'active',

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS valuation_snapshots (

      id BIGSERIAL PRIMARY KEY,

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

      market JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      fundamentals JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      valuation JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      ai_assessment TEXT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS management_promises (

      id BIGSERIAL PRIMARY KEY,

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

      report_id BIGINT
        REFERENCES reports(id)
        ON DELETE SET NULL,

      promise TEXT NOT NULL,

      target_date DATE,

      status TEXT
        NOT NULL
        DEFAULT 'open',

      evidence JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS monitoring_events (

      id BIGSERIAL PRIMARY KEY,

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

      event_type TEXT NOT NULL,

      title TEXT NOT NULL,

      severity TEXT
        NOT NULL
        DEFAULT 'info',

      payload JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,

    `
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
    )
    `

  ];


  for (
    const statement of statements
  ) {

    try {

      await pool.query(
        statement
      );

    }

    catch (
      error
    ) {

      console.error(
        "Database schema warning:",
        error.message
      );

    }

  }


  /*
   * Existing installations may have an older companies table.
   */

  const optionalColumns = [

  /*
   * COMPANIES
   */

  `
  ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS
  listing_status TEXT
  `,

  `
  ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS
  isin TEXT
  `,


  /*
   * REPORTS
   *
   * Older FinSight databases may already have
   * this table without the newer columns.
   */

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  filename TEXT
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  report_year INTEGER
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  metrics JSONB
  DEFAULT '{}'::jsonb
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  analysis JSONB
  DEFAULT '{}'::jsonb
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  source_hash TEXT
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  created_at TIMESTAMPTZ
  DEFAULT NOW()
  `,


  /*
   * VALUATION SNAPSHOTS
   */

  `
  ALTER TABLE valuation_snapshots
  ADD COLUMN IF NOT EXISTS
  created_at TIMESTAMPTZ
  DEFAULT NOW()
  `,


  /*
   * MANAGEMENT PROMISES
   */

  `
  ALTER TABLE management_promises
  ADD COLUMN IF NOT EXISTS
  created_at TIMESTAMPTZ
  DEFAULT NOW()
  `,

  `
  ALTER TABLE management_promises
  ADD COLUMN IF NOT EXISTS
  updated_at TIMESTAMPTZ
  DEFAULT NOW()
  `,


  /*
   * MONITORING EVENTS
   */

  `
  ALTER TABLE monitoring_events
  ADD COLUMN IF NOT EXISTS
  created_at TIMESTAMPTZ
  DEFAULT NOW()
  `

];


  for (
    const statement of optionalColumns
  ) {

    try {

      await pool.query(
        statement
      );

    }

    catch (
      error
    ) {

      console.error(
        "Database migration warning:",
        error.message
      );

    }

  }


  console.log(
    "FinSight database ready."
  );

}


async function ensureResearchTables() {

  if (!pool) return;

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS research_theses (
      id BIGSERIAL PRIMARY KEY,
      company_id TEXT NOT NULL,
      thesis TEXT NOT NULL,
      bull_case TEXT,
      bear_case TEXT,
      thesis_breakers JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

}


/* ============================================================
   4. COMPANY DATABASE HELPER
   ============================================================ */

async function upsertCompany({

  name,

  ticker = null,

  exchange = null,

  sector = null,

  listingStatus = null,

  isin = null

}) {

  if (!pool) {

    throw new Error(
      "Database is not configured."
    );

  }


  const normalizedTicker =

    ticker

      ? String(ticker)
          .trim()
          .toUpperCase()

      : null;


  const normalizedExchange =

    exchange

      ? String(exchange)
          .trim()
          .toUpperCase()

      : null;


  if (
    normalizedTicker &&
    normalizedExchange
  ) {

    const result =
      await dbQuery(
        `
        INSERT INTO companies
        (
          name,
          ticker,
          exchange,
          sector,
          listing_status,
          isin
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )

        ON CONFLICT
        (
          ticker,
          exchange
        )

        DO UPDATE SET

          name =
            EXCLUDED.name,

          sector =
            COALESCE(
              EXCLUDED.sector,
              companies.sector
            ),

          listing_status =
            COALESCE(
              EXCLUDED.listing_status,
              companies.listing_status
            ),

          isin =
            COALESCE(
              EXCLUDED.isin,
              companies.isin
            ),

          updated_at =
            NOW()

        RETURNING *
        `,
        [
          name ||
          normalizedTicker,

          normalizedTicker,

          normalizedExchange,

          sector,

          listingStatus,

          isin
        ]
      );


    return result.rows[0];

  }


  const existing =
    await dbQuery(
      `
      SELECT *
      FROM companies

      WHERE LOWER(name) =
            LOWER($1)

      LIMIT 1
      `,
      [
        name ||
        "Unknown company"
      ]
    );


  if (
    existing.rows[0]
  ) {

    const updated =
      await dbQuery(
        `
        UPDATE companies

        SET
          listing_status =
            COALESCE(
              $2,
              listing_status
            ),

          isin =
            COALESCE(
              $3,
              isin
            ),

          updated_at =
            NOW()

        WHERE id = $1

        RETURNING *
        `,
        [
          existing.rows[0].id,
          listingStatus,
          isin
        ]
      );


    return updated.rows[0];

  }


  const result =
    await dbQuery(
      `
      INSERT INTO companies
      (
        name,
        ticker,
        exchange,
        sector,
        listing_status,
        isin
      )

      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6
      )

      RETURNING *
      `,
      [
        name ||
        "Unknown company",

        normalizedTicker,

        normalizedExchange,

        sector,

        listingStatus,

        isin

      ]
    );


  return result.rows[0];

}


/* ============================================================
   5. FILE UPLOAD
   ============================================================ */

const upload =
  multer({

    storage:
      multer.memoryStorage(),

    limits: {

      fileSize:
        45 *
        1024 *
        1024

    }

  });


/* ============================================================
   6. EXPRESS
   ============================================================ */

app.use(
  express.json({
    limit: "15mb"
  })
);


app.use(
  express.urlencoded({
    extended: true,
    limit: "15mb"
  })
);


/* ============================================================
   7. BASIC AUTH
   ============================================================ */

function basicAuth(
  req,
  res,
  next
) {

  if (
    [
      "/healthz",
      "/api/health",
      "/api/session",
      "/api/login",
      "/api/logout"
    ].includes(req.path) ||
    /\.(css|js|png|jpg|jpeg|svg|ico|woff2?)$/i.test(
      req.path
    )
  ) {

    return next();

  }


  if (
    !FINSIGHT_USERNAME ||
    !FINSIGHT_PASSWORD
  ) {

    return next();

  }


  const raw =
    req.headers.authorization ||
    "";


  const [
    kind,
    encoded
  ] =
    raw.split(" ");


  if (
    kind === "Basic" &&
    encoded
  ) {

    try {

      const decoded =
        Buffer
          .from(
            encoded,
            "base64"
          )
          .toString(
            "utf8"
          );


      const separator =
        decoded.indexOf(":");


      const username =

        separator >= 0

          ? decoded.slice(
              0,
              separator
            )

          : decoded;


      const password =

        separator >= 0

          ? decoded.slice(
              separator + 1
            )

          : "";


      if (
        username ===
          FINSIGHT_USERNAME

        &&

        password ===
          FINSIGHT_PASSWORD
      ) {

        return next();

      }

    }

    catch {

      /* Authentication fails below. */

    }

  }


  res.set(
    "WWW-Authenticate",
    'Basic realm="FinSight"'
  );


  return res
    .status(401)
    .send(
      "Authentication required."
    );

}


app.use(
  basicAuth
);


/* ============================================================
   8. STATIC SITE
   ============================================================ */

app.use(
  express.static(
    __dirname
  )
);


app.get(
  "/",
  (
    req,
    res
  ) => {

    res.sendFile(
      path.join(
        __dirname,
        "finsight-investor.html"
      )
    );

  }
);

function requestUser(req) {
  const token = String(
    req.headers.cookie || ""
  ).match(
    /finsight_session=([^;]+)/
  )?.[1];

  return token
    ? sessions.get(token) || null
    : null;
}

async function recordUsage(
  req,
  eventType,
  details = {}
) {
  const user =
    requestUser(req)?.name ||
    "anonymous";

  if (!pool) return;

  try {
    await dbQuery(
      `
      INSERT INTO usage_events
      (
        event_id,
        username,
        event_type,
        filename,
        company,
        report_year,
        status,
        gemini_model,
        error_message
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        crypto.randomUUID(),
        user,
        eventType,
        details.filename || null,
        details.company || null,
        details.reportYear || null,
        details.status || null,
        details.model || GEMINI_MODEL,
        details.error || null
      ]
    );
  } catch (error) {
    console.error(
      "Usage event persistence failed:",
      error.message
    );
  }
}

app.get(
  "/api/session",
  (req, res) => {
    const user = requestUser(req);

    return user
      ? res.json({
          ok: true,
          name: user.name,
          admin: user.admin
        })
      : res.json({
          ok: false
        });
  }
);

app.post(
  "/api/login",
  async (req, res) => {
    const name = String(
      req.body?.name || ""
    )
      .trim()
      .slice(0, 120);

    const password = String(
      req.body?.password || ""
    );

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Enter your name."
      });
    }

    if (
      FINSIGHT_PASSWORD &&
      password !== FINSIGHT_PASSWORD
    ) {
      return res.status(401).json({
        ok: false,
        error: "Invalid access password."
      });
    }

    const token = crypto.randomBytes(32).toString(
      "hex"
    );

    const admin = Boolean(
      FINSIGHT_ADMIN_PASSWORD &&
      password === FINSIGHT_ADMIN_PASSWORD
    );

    sessions.set(token, {
      name,
      admin,
      createdAt: Date.now()
    });

    res.setHeader(
      "Set-Cookie",
      `finsight_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
    );

    await recordUsage(
      {
        headers: {
          cookie: `finsight_session=${token}`
        }
      },
      "login"
    );

    return res.json({
      ok: true,
      name,
      admin
    });
  }
);

app.post(
  "/api/logout",
  async (req, res) => {
    await recordUsage(
      req,
      "logout"
    );

    const token = String(
      req.headers.cookie || ""
    ).match(
      /finsight_session=([^;]+)/
    )?.[1];

    if (token) {
      sessions.delete(token);
    }

    res.setHeader(
      "Set-Cookie",
      "finsight_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    );

    return res.json({
      ok: true
    });
  }
);

app.get(
  "/api/admin/usage.xlsx",
  async (req, res) => {
    const user = requestUser(req);

    if (!user?.admin) {
      return res.status(403).json({
        ok: false,
        error: "Administrator access required."
      });
    }

    if (!pool) {
      return res.status(503).json({
        ok: false,
        error:
          "Usage history database is not configured."
      });
    }

    try {
      const result = await dbQuery(`
        SELECT
          event_id,
          username,
          event_type,
          filename,
          company,
          report_year,
          status,
          gemini_model,
          created_at,
          error_message
        FROM usage_events
        ORDER BY created_at ASC
      `);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(
        "Usage Log"
      );

      sheet.columns = [
        "Event ID",
        "User",
        "Event Type",
        "File Name",
        "Company",
        "Report Year",
        "Status",
        "Gemini Model",
        "Date",
        "Time",
        "Error"
      ].map(header => ({
        header,
        key: header
      }));

      result.rows.forEach(row => {
        const date = row.created_at
          ? new Date(row.created_at)
          : null;

        sheet.addRow({
          "Event ID": row.event_id,
          "User": row.username,
          "Event Type": row.event_type,
          "File Name": row.filename,
          Company: row.company,
          "Report Year": row.report_year,
          Status: row.status,
          "Gemini Model": row.gemini_model,
          Date: date?.toISOString().slice(0, 10),
          Time: date?.toISOString().slice(11, 19),
          Error: row.error_message
        });
      });

      sheet.getRow(1).font = {
        bold: true
      };

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      res.setHeader(
        "Content-Disposition",
        "attachment; filename=finsight-usage.xlsx"
      );

      await workbook.xlsx.write(res);

      return res.end();
    } catch (error) {
      console.error(
        "Usage export failed:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Usage history could not be exported."
      });
    }
  }
);


/* ============================================================
   9. HEALTH
   ============================================================ */

app.get(
  "/healthz",
  (
    req,
    res
  ) => {

    res
      .status(200)
      .send("ok");

  }
);


app.get(
  "/api/health",
  async (
    req,
    res
  ) => {

    let databaseReady =
      false;


    if (pool) {

      try {

        await dbQuery(
          "SELECT 1"
        );


        databaseReady =
          true;

      }

      catch (
        error
      ) {

        console.error(
          "Database health:",
          error.message
        );

      }

    }


    res.json({

      ok:
        true,

      aiConfigured:
        Boolean(
          GEMINI_API_KEY
        ),

      model:
        GEMINI_MODEL,

      aiPrimaryProvider:
        "gemini",

      aiFallbackProvider:
        null,

      aiProviders: {

        gemini: {

          configured:
            Boolean(
              GEMINI_API_KEY
            ),

          model:
            GEMINI_MODEL,

          scope:
            "financial extraction and qualitative text analysis"

        },

        localPdf: {

          configured:
            true,

          engine:
            "pdf-parse + Gemini extraction",

          maxUploadMb:
            45

        }

      },

      databaseConfigured:
        databaseEnabled,

      databaseReady,

      protected:
        Boolean(
          FINSIGHT_USERNAME &&
          FINSIGHT_PASSWORD
        ),

      reportFinancialExtraction:
        true,

      pdfProcessing:
        "server-side"

    });

  }
);


/* ============================================================
   10. JSON FETCH HELPER
   ============================================================ */

async function fetchJSON(
  url,
  options = {}
) {

  const response =
    await fetch(
      url,
      options
    );


  const text =
    await response.text();


  let body = {};


  if (text) {

    try {

      body =
        JSON.parse(
          text
        );

    }

    catch {

      body = {
        raw:
          text
      };

    }

  }


  if (!response.ok) {

    const providerError =
      body?.error;

    const providerMessage =
      typeof providerError === "string"
        ? providerError
        : providerError?.message;

    const message =
      providerMessage ||
      body?.message ||
      body?.raw ||
      `HTTP ${response.status}`;

    const error =
      new Error(
        typeof message === "string"
          ? message
          : JSON.stringify(
              message
            )
      );

    error.status =
      response.status;

    error.providerStatus =
      providerError?.status ||
      null;

    error.providerDetails =
      providerError?.details ||
      null;

    throw error;
  }


  return body;
}


/* ============================================================
   11. SAFE JSON
   ============================================================ */
function safeJSON(value) {

  if (value == null) {

    return null;

  }

  if (typeof value === "object") {

    return value;

  }

  try {

    let text = String(value).trim();

    /*

     * Remove Markdown code fences:

     *

     * ```json

     * {...}

     * ```

     */

    text = text

      .replace(/^```(?:json)?\s*/i, "")

      .replace(/\s*```$/, "")

      .trim();

    /*

     * Gemini may surround JSON with explanatory text.

     * Extract the outermost JSON object or array.

     */

    const firstObject = text.search(/[\[{]/);

    const lastObject = Math.max(

      text.lastIndexOf("}"),

      text.lastIndexOf("]")

    );

    if (

      firstObject >= 0 &&

      lastObject > firstObject

    ) {

      text = text.slice(

        firstObject,

        lastObject + 1

      );

    }

    return JSON.parse(text);

  } catch {

    return null;

  }

}
/* ============================================================
   12. GEMINI
   ============================================================ */

const analystInstructions = `
You are FinSight AI, an evidence-first equity research system.

Use only the supplied annual-report evidence.

Never invent:
- financial values
- ticker symbols
- exchanges
- listing status
- auditor findings
- management statements
- share prices
- valuation multiples

Prefer audited consolidated statements.
Never mix standalone and consolidated figures
without clearly identifying them.

Distinguish:
REPORTED FACT
CALCULATED METRIC
MANAGEMENT CLAIM
AI INTERPRETATION

Do not issue personalized buy or sell instructions.
`;

function extractGeminiText(payload) {
  return (
    payload
      ?.candidates
      ?.[0]
      ?.content
      ?.parts || []
  )
    .map(part => part?.text || "")
    .join("\n")
    .trim();
}

function geminiModelUrl(model) {
  return (
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent"
  );
}

function isGeminiTemporaryError(error) {
  const status = Number(error?.status);

  const providerStatus = String(
    error?.providerStatus || ""
  )
    .trim()
    .toUpperCase();

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    providerStatus === "UNAVAILABLE" ||
    providerStatus === "RESOURCE_EXHAUSTED" ||
    providerStatus === "INTERNAL"
  );
}

async function geminiGenerate(
  parts,
  { json = false } = {}
) {
  if (!GEMINI_API_KEY) {
    const error = new Error(
      "Gemini extraction is not configured on the server. Add GEMINI_API_KEY in Render environment variables."
    );

    error.status = 503;
    throw error;
  }

  if (!Array.isArray(parts) || !parts.length) {
    throw new Error(
      "Gemini requires text input."
    );
  }

  const safeParts = parts.map(part => ({
    text: String(part?.text || "")
  }));

  const primaryModel = String(
    GEMINI_MODEL ||
    "gemini-3.1-flash-lite"
  ).trim();

  const fallbackModel = String(
    process.env.GEMINI_FALLBACK_MODEL || ""
  ).trim();

  const body = {
    system_instruction: {
      parts: [
        {
          text: analystInstructions
        }
      ]
    },

    contents: [
      {
        role: "user",
        parts: safeParts
      }
    ],

    generationConfig: json
      ? {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      : {
          temperature: 0.15
        }
  };

  const requestOptions = {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },

    body: JSON.stringify(body)
  };

  async function requestModel(model) {
    console.log(
      `Gemini text request: ${model}`
    );

    return fetchJSON(
      geminiModelUrl(model),
      {
        ...requestOptions,
        signal: AbortSignal.timeout(60000)
      }
    );
  }

  let payload;
  let modelUsed = primaryModel;

  try {
    payload = await requestModel(primaryModel);
  } catch (primaryError) {
    if (
      !fallbackModel ||
      fallbackModel === primaryModel ||
      !isGeminiTemporaryError(primaryError)
    ) {
      throw primaryError;
    }

    console.warn(
      `Gemini primary unavailable. Trying ${fallbackModel}.`
    );

    payload = await requestModel(fallbackModel);
    modelUsed = fallbackModel;
  }

  const responseText =
    extractGeminiText(payload);

  if (!responseText) {
    throw new Error(
      "Gemini returned no usable response."
    );
  }

  console.log(
    `Gemini text generation successful using ${modelUsed}.`
  );

  return responseText;
}
/* ============================================================
   13. LOCAL PDF EXTRACTION
   ============================================================ */

const FINSIGHT_MAX_PDF_SIZE =
  45 * 1024 * 1024;

async function extractPdfTextLocally(file) {
  if (
    !file ||
    !Buffer.isBuffer(file.buffer) ||
    !file.buffer.length
  ) {
    const error = new Error(
      "Annual-report PDF is empty or unavailable."
    );

    error.status = 400;
    throw error;
  }

  if (
    file.buffer.length >
    FINSIGHT_MAX_PDF_SIZE
  ) {
    const error = new Error(
      "The annual-report PDF exceeds FinSight's 45 MB upload limit."
    );

    error.status = 413;
    throw error;
  }

  console.log(
    `Local PDF extraction started: ${(
      file.buffer.length /
      1024 /
      1024
    ).toFixed(1)} MB`
  );

  let parsed;

  try {
    parsed = await pdfParse(file.buffer);
  } catch (error) {
    console.error(
      "Local PDF parser error:",
      error
    );

    const localError = new Error(
      "The PDF could not be read locally. Confirm that it is a valid text-based PDF."
    );

    localError.status = 400;
    throw localError;
  }

  const text = String(parsed?.text || "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  if (text.length < 500) {
    const error = new Error(
      "Very little text could be extracted from this PDF. The report may be scanned or image-based."
    );

    error.status = 400;
    throw error;
  }

  console.log(
    `Local PDF extraction successful: ${text.length.toLocaleString()} characters.`
  );

  return {
    text,
    pages: Number(parsed?.numpages) || null,
    info: parsed?.info || null
  };
}

/* ============================================================
   14. FINANCIAL EXTRACTION NORMALIZATION
   ============================================================ */

function dashboardNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let text = String(value).trim();

  if (
    /^(n\/a|na|null|not available|not disclosed|—|-)$/i.test(
      text
    )
  ) {
    return null;
  }

  let negative = false;

  if (/^\(.+\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text
    .replace(/[₹,$£€]/g, "")
    .replace(/,/g, "")
    .trim();

  const number = Number(text);

  if (!Number.isFinite(number)) {
    return null;
  }

  return negative ? -number : number;
}

function unitFactor(unit) {
  const text = String(
    unit || "INR crore"
  ).toLowerCase();

  if (text.includes("billion")) return 100;
  if (text.includes("million")) return 0.1;
  if (text.includes("lakh")) return 0.01;

  return 1;
}

function normalizedMoney(value, unit) {
  const number = dashboardNumber(value);

  return number == null
    ? null
    : number * unitFactor(unit);
}

function normalizedShares(value, unit) {
  const number = dashboardNumber(value);

  if (number == null) {
    return null;
  }

  const text = String(
    unit || "crore shares"
  ).toLowerCase();

  if (text.includes("million")) {
    return number / 10;
  }

  if (text.includes("lakh")) {
    return number / 100;
  }

  if (text.includes("crore")) {
    return number;
  }

  return number / 10000000;
}

function dashboardRow(
  row = {},
  companyName = "Unknown company"
) {
  let financialYear =
    row.financial_year ??
    row.financialYear ??
    null;

  let year = dashboardNumber(
    row.year ?? row.end_year
  );

  if (!year && financialYear) {
    const years = String(
      financialYear
    ).match(/20\d{2}/g);

    if (years?.length) {
      year = Math.max(
        ...years.map(Number)
      );
    }
  }

  if (!financialYear && year) {
    financialYear =
      `${year - 1}-${String(year).slice(-2)}`;
  }

  const sourceUnit =
    row.source_unit ??
    row.original_source_unit ??
    "INR crore";

  const money = value =>
    normalizedMoney(value, sourceUnit);

  return {
    company:
      row.company ??
      row.company_name ??
      companyName,

    financial_year: financialYear,
    year,

    statement_basis:
      row.statement_basis ??
      "Consolidated",

    source_unit: "INR crore",

    original_source_unit:
      row.original_source_unit ??
      row.source_unit ??
      null,

    revenue: money(
      row.revenue ??
      row.revenue_from_operations
    ),

    total_income: money(
      row.total_income
    ),

    other_income: money(
      row.other_income
    ),

    ebitda: money(row.ebitda),

    cogs: money(
      row.cogs ??
      row.cost_of_goods_sold
    ),

    operating_income: money(
      row.operating_income ??
      row.operating_profit ??
      row.ebit
    ),

    net_income: money(
      row.net_income ??
      row.net_profit ??
      row.profit_after_tax ??
      row.pat ??
      row.profit_for_the_year
    ),

    finance_cost: money(
      row.finance_cost ??
      row.finance_costs ??
      row.interest_expense
    ),

    total_assets: money(
      row.total_assets
    ),

    current_assets: money(
      row.current_assets ??
      row.total_current_assets
    ),

    current_liabilities: money(
      row.current_liabilities ??
      row.total_current_liabilities
    ),

    total_debt: money(
      row.total_debt ??
      row.total_borrowings ??
      row.borrowings
    ),

    cash: money(
      row.cash ??
      row.cash_and_equivalents ??
      row.cash_and_cash_equivalents
    ),

    net_debt_cash: money(
      row.net_debt_cash
    ),

    total_equity: money(
      row.total_equity ??
      row.shareholders_equity ??
      row.shareholder_equity
    ),

    inventory: money(
      row.inventory ??
      row.inventories
    ),

    accounts_receivable: money(
      row.accounts_receivable ??
      row.receivables ??
      row.trade_receivables
    ),

    accounts_payable: money(
      row.accounts_payable ??
      row.payables ??
      row.trade_payables
    ),

    operating_cash_flow: money(
      row.operating_cash_flow ??
      row.cash_flow_from_operations ??
      row.net_cash_from_operating_activities
    ),

    capex: money(
      row.capex ??
      row.capital_expenditure
    ),

    shares_outstanding: normalizedShares(
      row.shares_outstanding ??
      row.period_end_shares_outstanding,
      row.shares_outstanding_unit
    ),

    shares_outstanding_unit:
      row.shares_outstanding_unit ??
      "crore shares",

    source_pages:
      Array.isArray(row.source_pages)
        ? row.source_pages
        : [],

    extraction_notes:
      row.extraction_notes ?? null
  };
}

function normalizeGeminiDashboardPayload(
  raw = {}
) {
  let payload = raw;

  if (Array.isArray(payload)) {
    payload = payload[0] ?? {};
  }

  if (
    payload.result &&
    typeof payload.result === "object"
  ) {
    payload = payload.result;
  }

  if (
    payload.data &&
    typeof payload.data === "object"
  ) {
    payload = payload.data;
  }

  const company =
    payload.company &&
    typeof payload.company === "object"
      ? payload.company
      : {};

  const companyName =
    company.name ??
    company.legal_name ??
    payload.company_name ??
    "Unknown company";

  let rows =
    payload.financials ??
    payload.financial_rows ??
    payload.financial_history ??
    payload.years ??
    [];

  if (
    !Array.isArray(rows) &&
    rows &&
    typeof rows === "object"
  ) {
    rows = Object.values(rows);
  }

  const financials = (
    Array.isArray(rows) ? rows : []
  )
    .map(row =>
      dashboardRow(row, companyName)
    )
    .filter(row =>
      row.year != null ||
      row.financial_year
    )
    .sort(
      (a, b) =>
        (a.year ?? 0) - (b.year ?? 0)
    );

  if (!financials.length) {
    throw new Error(
      "Gemini returned no dashboard-compatible financial-year rows."
    );
  }

  return {
    company: {
      name: company.name ?? companyName,
      legal_name:
        company.legal_name ?? companyName,
      listing_status:
        company.listing_status ?? "unknown",
      ticker: company.ticker ?? null,
      exchange: company.exchange ?? null,
      nse_code: company.nse_code ?? null,
      bse_code: company.bse_code ?? null,
      isin: company.isin ?? null,
      currency: company.currency ?? "INR",
      extraction_confidence:
        company.extraction_confidence ??
        payload.extraction_confidence ??
        payload.confidence ??
        "Gemini extracted"
    },

    financials,

    validation: {
      consolidated_preferred: true,
      years_found: financials
        .map(row => row.financial_year)
        .filter(Boolean),

      warnings: Array.isArray(
        payload.warnings
      )
        ? payload.warnings
        : []
    }
  };
}
/* ============================================================
   15. ANNUAL REPORT AI ANALYSIS
   ============================================================ */

app.post(
  "/api/ai/analyze-report",
  upload.single("report"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "Upload an annual-report PDF."
        });
      }

      const isPdf =
        req.file.mimetype === "application/pdf" ||
        /\.pdf$/i.test(
          req.file.originalname || ""
        );

      if (!isPdf) {
        return res.status(400).json({
          ok: false,
          error: "Please upload a valid PDF."
        });
      }

      const pdfData =
        await extractPdfTextLocally(req.file);

      const metrics =
        safeJSON(req.body?.metrics);

      const reportText =
        pdfData.text.length > 900000
          ? pdfData.text.slice(0, 900000)
          : pdfData.text;

      const prompt = `
You are FinSight AI.

Analyze this annual-report evidence using only
the supplied report text and structured financial data.

Never invent facts or financial values.
If evidence is missing, use null or an empty array.

STRUCTURED FINANCIAL DATA:
${JSON.stringify(metrics || {}, null, 2)}

ANNUAL REPORT TEXT:
${reportText}

Return valid JSON only:

{
  "company": "",
  "report_type": "single",
  "financial_years": [],
  "overall_view": "",
  "confidence": "High|Medium|Low",
  "business_summary": "",
  "financial_summary": "",
  "cash_flow_summary": "",
  "management_assessment": "",
  "governance_assessment": "",
  "auditor_assessment": "",
  "risks": [],
  "good": [],
  "bad": [],
  "watch": [],
  "investor_questions": [],
  "missing_information": []
}

Every item in risks, good, bad and watch should be:

{
  "title": "",
  "explanation": "",
  "evidence": [],
  "priority": "High|Medium|Low"
}
`;

      const responseText = await geminiGenerate(
        [
          {
            text: prompt
          }
        ],
        {
          json: true
        }
      );

      const analysis =
        safeJSON(responseText);

      if (!analysis) {
        throw new Error(
          "Gemini returned unreadable analysis JSON."
        );
      }

      return res.json({
        ok: true,
        analysis,
        provider: "gemini",
        model: GEMINI_MODEL,
        pdfProcessing: "local"
      });
    } catch (error) {
      console.error(
        "Annual report AI error:",
        error
      );

      const status =
        Number(error?.status) >= 400
          ? Number(error.status)
          : 500;

      return res.status(status).json({
        ok: false,
        error:
          status === 429
            ? "AI quota has been reached. Please try again later."
            : "The annual report could not be analyzed."
      });
    }
  }
);

/* ============================================================
   16. ASK FINSIGHT
   ============================================================ */

app.post(
  "/api/ai/ask",
  async (req, res) => {
    try {
      const {
        question,
        company,
        financials,
        reportAnalysis,
        pdfContext
      } = req.body || {};

      if (
        !question ||
        !String(question).trim()
      ) {
        return res.status(400).json({
          ok: false,
          error: "A question is required."
        });
      }

      const prompt = `
You are FinSight AI, an evidence-first
annual-report research assistant.

Answer only from the supplied financial data
and annual-report evidence.

Never invent financial values.
If the evidence does not support an answer,
say that the information is unavailable.

Do not provide personalized buy or sell advice.

COMPANY:
${JSON.stringify(company || {}, null, 2)}

FINANCIAL DATA:
${JSON.stringify(financials || [], null, 2)}

REPORT ANALYSIS:
${JSON.stringify(reportAnalysis || {}, null, 2)}

REPORT EVIDENCE:
${String(pdfContext || "").slice(0, 300000)}

USER QUESTION:
${String(question).trim()}

Return valid JSON only:

{
  "answer": "",
  "evidence": [],
  "calculation": null,
  "confidence": "High|Medium|Low",
  "missing_information": []
}
`;

      const responseText = await geminiGenerate(
        [
          {
            text: prompt
          }
        ],
        {
          json: true
        }
      );

      const answer =
        safeJSON(responseText);

      if (!answer) {
        throw new Error(
          "Gemini returned unreadable answer JSON."
        );
      }

      return res.json({
        ok: true,
        answer,
        provider: "gemini",
        model: GEMINI_MODEL
      });
    } catch (error) {
      console.error(
        "Ask FinSight error:",
        error
      );

      const status =
        Number(error?.status) >= 400
          ? Number(error.status)
          : 500;

      return res.status(status).json({
        ok: false,
        error:
          status === 429
            ? "AI quota has been reached. Please try again later."
            : "FinSight could not answer that question."
      });
    }
  }
);
/* ============================================================
   17. GEMINI FINANCIAL EXTRACTION
   ============================================================ */

app.post(
  "/api/ai/extract-financials",
  upload.single("report"),
  async (req, res) => {

    const filename =
      req.file?.originalname ||
      "unknown.pdf";

    try {

      /* --------------------------------------------------------
         VALIDATE FILE
         -------------------------------------------------------- */

      if (!req.file) {

        return res.status(400).json({
          ok: false,
          error: "Upload an annual-report PDF."
        });

      }


      const isPdf =

        req.file.mimetype === "application/pdf" ||

        /\.pdf$/i.test(
          filename
        );


      if (!isPdf) {

        return res.status(400).json({
          ok: false,
          error: "Please upload a valid PDF annual report."
        });

      }


      await recordUsage(
        req,
        "financial_extraction_started",
        {
          filename,
          status: "started",
          model: GEMINI_MODEL
        }
      );


      /* --------------------------------------------------------
         EXTRACT PDF TEXT LOCALLY
         -------------------------------------------------------- */

      const pdfData =
        await extractPdfTextLocally(
          req.file
        );


      /*
       * Large annual reports can exceed practical
       * Gemini context limits.
       *
       * Keep a large but bounded amount of report text.
       */

      const MAX_REPORT_CHARACTERS =
        900000;


      const reportText =

        pdfData.text.length >
        MAX_REPORT_CHARACTERS

          ? pdfData.text.slice(
              0,
              MAX_REPORT_CHARACTERS
            )

          : pdfData.text;


      console.log(
        `Sending ${reportText.length.toLocaleString()} characters to Gemini for financial extraction.`
      );


      /* --------------------------------------------------------
         EXTRACTION PROMPT
         -------------------------------------------------------- */

      const prompt = `
You are FinSight AI's financial-statement extraction engine.

Your job is to extract structured financial information from the supplied annual report.

IMPORTANT RULES:

1. Use ONLY information contained in the annual report.

2. NEVER invent a number.

3. If a value cannot be reliably identified, return null.

4. Prefer AUDITED CONSOLIDATED financial statements.

5. Do NOT mix standalone and consolidated figures.

6. Extract every financial year that can be reliably identified.

7. Keep values for the same financial year on the same accounting basis.

8. Revenue means operating/customer revenue or revenue from operations.

9. Do NOT substitute total income for revenue.

10. Operating income means EBIT / operating profit where reliably available.

11. EBITDA should only be returned when reported or reliably derivable from disclosed financial information.

12. Net income means profit after tax / profit for the year attributable to the relevant consolidated entity.

13. Cash should represent cash and cash equivalents unless the report explicitly identifies another amount appropriate for net-debt calculations.

14. Total debt should include interest-bearing borrowings.

15. Operating cash flow means net cash generated from operating activities.

16. Capex should represent purchases/additions of property, plant, equipment and relevant capital assets where reliably identifiable.

17. Do not treat all investing cash flows as capex.

18. Preserve negative numbers.

19. Financial values must include their source unit.

20. Shares outstanding must include the unit.

21. Do not calculate financial ratios. The FinSight frontend calculates ratios.

22. Return STRICT VALID JSON ONLY.

23. Do not wrap the JSON in Markdown.

24. Do not add commentary before or after JSON.


ANNUAL REPORT TEXT:

${reportText}


RETURN EXACTLY THIS GENERAL STRUCTURE:

{
  "company": {
    "name": null,
    "legal_name": null,
    "listing_status": "listed|unlisted|pre-ipo|unknown",
    "ticker": null,
    "exchange": null,
    "nse_code": null,
    "bse_code": null,
    "isin": null,
    "currency": "INR",
    "extraction_confidence": "High|Medium|Low"
  },

  "financials": [
    {
      "company": null,

      "financial_year": null,

      "year": null,

      "statement_basis": "Consolidated",

      "source_unit": "INR crore",

      "revenue": null,

      "total_income": null,

      "other_income": null,

      "ebitda": null,

      "cogs": null,

      "operating_income": null,

      "net_income": null,

      "finance_cost": null,

      "total_assets": null,

      "current_assets": null,

      "current_liabilities": null,

      "total_debt": null,

      "cash": null,

      "net_debt_cash": null,

      "total_equity": null,

      "inventory": null,

      "accounts_receivable": null,

      "accounts_payable": null,

      "operating_cash_flow": null,

      "capex": null,

      "shares_outstanding": null,

      "shares_outstanding_unit": null,

      "source_pages": [],

      "extraction_notes": null
    }
  ],

  "warnings": []
}


UNIT RULES:

If the report uses:

₹ crore
INR crore
Rs crore

use:

"source_unit": "INR crore"


If it uses INR million, use:

"source_unit": "INR million"


If it uses INR billion, use:

"source_unit": "INR billion"


Do NOT convert the values yourself unless absolutely necessary.
The server normalization layer will convert them.


FINANCIAL YEAR RULE:

For FY 2024-25:

"financial_year": "FY2024-25"

"year": 2025


For FY 2023-24:

"financial_year": "FY2023-24"

"year": 2024


STATEMENT BASIS:

Prefer:

"Consolidated"

Only use standalone values if consolidated values genuinely do not exist.

Never silently combine them.


OPERATING PROFIT:

Look for terms such as:

Operating profit
Profit from operations
EBIT
Earnings before interest and tax

Do NOT automatically use EBITDA as EBIT.


REVENUE:

Look for:

Revenue from operations
Revenue
Revenue from contracts with customers
Sales

Do NOT use total income as revenue.


NET PROFIT:

Look for:

Profit after tax
Profit for the year
Net profit
PAT


DEBT:

Look for interest-bearing:

Borrowings
Current borrowings
Non-current borrowings
Lease liabilities where appropriate

Avoid treating trade payables as debt.


CASH:

Look for:

Cash and cash equivalents
Cash balances
Bank balances when clearly cash-equivalent


OPERATING CASH FLOW:

Use:

Net cash generated from operating activities
Net cash from operating activities


CAPEX:

Look for:

Purchase of property plant and equipment
Purchase of fixed assets
Additions to PPE
Capital expenditure


RECEIVABLES:

Prefer:

Trade receivables


PAYABLES:

Prefer:

Trade payables


SHARES:

Extract period-end shares outstanding if reliably available.

Return the actual unit, for example:

"crore shares"

"million shares"

"lakh shares"

"shares"


QUALITY CHECK BEFORE RETURNING JSON:

Check that:

- years are not duplicated
- consolidated is preferred
- revenue is not total income
- assets and liabilities are not accidentally swapped
- cash is not total investments
- debt is not total liabilities
- operating cash flow is not total cash-flow movement
- capex is not total investing cash flow
- shares have a unit
- missing values are null

Return JSON only.
`;


      /* --------------------------------------------------------
         CALL GEMINI
         -------------------------------------------------------- */

      const responseText =
        await geminiGenerate(
          [
            {
              text: prompt
            }
          ],
          {
            json: true
          }
        );


      console.log(
        "Gemini financial extraction response received."
      );


      /* --------------------------------------------------------
         PARSE GEMINI JSON
         -------------------------------------------------------- */

      const rawExtraction =
        safeJSON(
          responseText
        );


      if (!rawExtraction) {

        throw new Error(
          "Gemini returned financial information, but the response was not valid JSON."
        );

      }


      /*
       * Convert Gemini's response into the exact
       * structure expected by finsight-investor.js.
       */

      const normalized =
        normalizeGeminiDashboardPayload(
          rawExtraction
        );


      if (
        !Array.isArray(
          normalized.financials
        ) ||
        !normalized.financials.length
      ) {

        throw new Error(
          "Gemini did not return any usable financial years."
        );

      }


      /* --------------------------------------------------------
         EXTRACTION QUALITY CHECK
         -------------------------------------------------------- */

      const usableRows =

        normalized.financials.filter(
          row => {

            const fields = [

              row.revenue,
              row.total_income,
              row.ebitda,
              row.operating_income,
              row.net_income,
              row.total_assets,
              row.total_equity,
              row.operating_cash_flow

            ];


            return fields.some(
              value =>
                value !== null &&
                value !== undefined
            );

          }
        );


      if (!usableRows.length) {

        throw new Error(
          "Gemini identified reporting years but did not extract usable financial statement values."
        );

      }


      normalized.financials =
        usableRows;


      const latest =
        usableRows.at(-1);


      const companyName =

        normalized.company?.name ||

        latest?.company ||

        "Unknown company";


      /* --------------------------------------------------------
         DATABASE REPORT STORAGE
         -------------------------------------------------------- */

      if (pool) {

        try {

          const company =
            await upsertCompany({

              name:
                companyName,

              ticker:
                normalized.company?.ticker,

              exchange:
                normalized.company?.exchange,

              listingStatus:
                normalized.company?.listing_status,

              isin:
                normalized.company?.isin

            });


          const sourceHash =

            crypto
              .createHash("sha256")
              .update(req.file.buffer)
              .digest("hex");


          await dbQuery(
            `
            INSERT INTO reports
            (
              company_id,
              filename,
              report_year,
              metrics,
              analysis,
              source_hash
            )

            VALUES
            (
              $1,
              $2,
              $3,
              $4::jsonb,
              $5::jsonb,
              $6
            )
            `,
            [

              company.id,

              filename,

              latest?.year || null,

              JSON.stringify(
                normalized.financials
              ),

              JSON.stringify({
                provider:
                  "gemini",

                model:
                  GEMINI_MODEL,

                pages:
                  pdfData.pages,

                validation:
                  normalized.validation
              }),

              sourceHash

            ]
          );

        }

        catch (
          databaseError
        ) {

          /*
           * Database failure must NOT prevent
           * the dashboard from receiving extraction.
           */

          console.error(
            "Report database persistence warning:",
            databaseError
          );

        }

      }


      /* --------------------------------------------------------
         RECORD SUCCESSFUL USAGE
         -------------------------------------------------------- */

      await recordUsage(
        req,
        "financial_extraction",
        {

          filename,

          company:
            companyName,

          reportYear:
            latest?.year ||
            null,

          status:
            "success",

          model:
            GEMINI_MODEL

        }
      );


      console.log(
        "FinSight extraction successful:",
        {
          company:
            companyName,

          years:
            normalized.financials.map(
              row =>
                row.financial_year
            )
        }
      );


      /* --------------------------------------------------------
         IMPORTANT:
         RETURN EXACT FORMAT EXPECTED BY DASHBOARD
         -------------------------------------------------------- */

      return res.json({

        ok:
          true,

        company:
          normalized.company,

        financials:
          normalized.financials,

        validation:
          normalized.validation,

        provider:
          "gemini",

        model:
          GEMINI_MODEL,

        pdfProcessing:
          "local",

        pages:
          pdfData.pages

      });

    }

    catch (
      error
    ) {

      console.error(
        "Financial extraction failed:",
        error
      );


      await recordUsage(
        req,
        "financial_extraction",
        {

          filename,

          status:
            "failed",

          model:
            GEMINI_MODEL,

          error:
            error?.message ||
            "Unknown extraction error"

        }
      );


      const status =

        Number(error?.status) >= 400

          ? Number(
              error.status
            )

          : 500;


      let message =
        error?.message ||
        "Annual-report financial extraction failed.";


      if (
        status === 429
      ) {

        message =
          "Gemini quota has been reached. Wait briefly and try the report again.";

      }


      if (
        status === 503
      ) {

        message =
          error?.message ||
          "Gemini is temporarily unavailable.";

      }


      return res
        .status(status)
        .json({

          ok:
            false,

          error:
            message

        });

    }

  }
);


/* ============================================================
   18. GLOBAL ERROR HANDLER
   ============================================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "FinSight server error:",
      error
    );


    /*
     * Multer upload size error.
     */

    if (
      error?.code ===
      "LIMIT_FILE_SIZE"
    ) {

      return res
        .status(413)
        .json({

          ok:
            false,

          error:
            "The PDF is too large. Maximum upload size is 45 MB."

        });

    }


    if (
      res.headersSent
    ) {

      return next(
        error
      );

    }


    return res
      .status(
        Number(
          error?.status
        ) || 500
      )
      .json({

        ok:
          false,

        error:
          error?.message ||
          "Unexpected server error."

      });

  }
);


/* ============================================================
   19. START SERVER
   ============================================================ */

async function startServer() {

  try {

    /*
     * Initialize PostgreSQL / Supabase tables.
     */

    if (pool) {

      try {

        await initDatabase();

        await ensureResearchTables();

      }

      catch (
        databaseError
      ) {

        /*
         * The application should still start even
         * if Supabase is temporarily unavailable.
         */

        console.error(
          "Database initialization warning:",
          databaseError
        );

      }

    }


    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "============================================"
        );

        console.log(
          "FinSight AI server started"
        );

        console.log(
          `Port: ${PORT}`
        );

        console.log(
          `Gemini configured: ${Boolean(
            GEMINI_API_KEY
          )}`
        );

        console.log(
          `Gemini model: ${GEMINI_MODEL}`
        );

        console.log(
          `Database configured: ${Boolean(
            pool
          )}`
        );

        console.log(
          "Financial extraction: enabled"
        );

        console.log(
          "Dashboard API: enabled"
        );

        console.log(
          "Usage logging: enabled"
        );

        console.log(
          "============================================"
        );

      }
    );

  }

  catch (
    error
  ) {

    console.error(
      "FinSight startup failed:",
      error
    );


    process.exit(1);

  }

}


startServer();

