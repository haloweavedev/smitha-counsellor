const http = require("node:http");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const ENV_PATH = path.join(ROOT, ".env");
const APPLICATIONS_PATH = path.join(ROOT, "applications.json");
const RESUME_FALLBACK_PATH = path.join(ROOT, "data", "resume.txt");
const COMPANY_INTEL_PATH = path.join(ROOT, "data", "company_intel.json");
const PORT = Number(process.env.PORT || 3010);

loadDotEnv(ENV_PATH);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || "gpt-4.1-mini";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL || "";
const MAX_HISTORY_MESSAGES = 12;
const sessions = new Map();
let inMemoryApplicationsData = null;
let pgPool = null;
let pgReadyPromise = null;
let aiSdkModules = null;
let companyIntelCache = null;
const ALLOWED_STATUSES = new Set(["applied", "screening", "interview", "assessment", "offer", "rejected", "withdrawn"]);
const APPLICATION_FIELDS = [
  "company",
  "role",
  "location",
  "date_applied",
  "status",
  "source",
  "contact_person",
  "contact_email",
  "resume_version",
  "job_url",
  "follow_up_date",
  "salary_range",
  "notes"
];

const contextCache = {
  resumePath: null,
  resumeMtimeMs: 0,
  resumeText: "",
  resumeChunks: [],
  applicationsMtimeMs: 0,
  applicationsData: { applications: [], application_advice: {} }
};

function loadDotEnv(filePath) {
  if (!fssync.existsSync(filePath)) return;
  const content = fssync.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function findResumePath() {
  const configured = process.env.RESUME_PATH;
  if (configured) {
    const absolute = path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
    if (fssync.existsSync(absolute)) return absolute;
  }

  const files = await fs.readdir(ROOT);
  const pdfs = files.filter((name) => /\.pdf$/i.test(name));
  if (!pdfs.length) return null;

  const preferred = pdfs.find((name) => /resume|cv/i.test(name));
  return path.join(ROOT, preferred || pdfs[0]);
}

function chunkText(text, maxChunkLength = 1400) {
  const clean = text.replace(/\u0000/g, "").replace(/\s+\n/g, "\n").trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length > maxChunkLength) {
      if (current) chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function normalizeToken(word) {
  return word.toLowerCase().replace(/[^a-z0-9+#]/g, "");
}

function scoreTextByQuery(text, query) {
  const textTokens = new Set(
    String(text || "")
      .split(/\s+/)
      .map(normalizeToken)
      .filter((t) => t.length > 2)
  );
  const queryTokens = String(query || "")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 2);
  if (!queryTokens.length) return 0;
  let score = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) score += 1;
  }
  return score;
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureApplicationsTemplate(rawData) {
  const base = rawData && typeof rawData === "object" ? { ...rawData } : {};
  if (!Array.isArray(base.applications)) base.applications = [];
  if (!base.application_advice || typeof base.application_advice !== "object") {
    base.application_advice = {};
  }
  return base;
}

function hasMeaningfulApplicationContent(app) {
  const meaningfulFields = [
    "company",
    "role",
    "location",
    "date_applied",
    "source",
    "contact_person",
    "contact_email",
    "resume_version",
    "job_url",
    "follow_up_date",
    "salary_range",
    "notes"
  ];
  return meaningfulFields.some((field) => String(app?.[field] || "").trim() !== "");
}

function sanitizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function sanitizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return text;
}

function sanitizeApplication(input, existingId) {
  const statusRaw = String(input?.status || "applied").trim().toLowerCase();
  const status = ALLOWED_STATUSES.has(statusRaw) ? statusRaw : "applied";
  const app = {
    id: String(existingId || input?.id || crypto.randomUUID()),
    company: String(input?.company || "").trim(),
    role: String(input?.role || "").trim(),
    location: String(input?.location || "").trim(),
    date_applied: sanitizeDate(input?.date_applied),
    status,
    source: String(input?.source || "").trim(),
    contact_person: String(input?.contact_person || "").trim(),
    contact_email: String(input?.contact_email || "").trim(),
    resume_version: String(input?.resume_version || "").trim(),
    job_url: sanitizeUrl(input?.job_url),
    follow_up_date: sanitizeDate(input?.follow_up_date),
    salary_range: String(input?.salary_range || "").trim(),
    notes: String(input?.notes || "").trim()
  };
  return app;
}

function getStoredAppId(app) {
  return String(app?.id || app?._id || "");
}

function serializeApplicationsFile(rawData) {
  return `${JSON.stringify(rawData, null, 2)}\n`;
}

async function readApplicationsFileRaw() {
  if (inMemoryApplicationsData) {
    return ensureApplicationsTemplate(cloneJson(inMemoryApplicationsData));
  }
  if (!fssync.existsSync(APPLICATIONS_PATH)) {
    return ensureApplicationsTemplate({ applications: [], application_advice: {} });
  }
  const rawText = await fs.readFile(APPLICATIONS_PATH, "utf8");
  const parsed = safeJsonParse(rawText, null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("applications.json is invalid JSON.");
  }
  return ensureApplicationsTemplate(parsed);
}

async function writeApplicationsFileRaw(rawData) {
  const safeData = ensureApplicationsTemplate(rawData);
  try {
    await fs.writeFile(APPLICATIONS_PATH, serializeApplicationsFile(safeData), "utf8");
    inMemoryApplicationsData = null;
    contextCache.applicationsMtimeMs = 0;
  } catch (err) {
    const isReadonlyFs = err && typeof err === "object" && ["EROFS", "EACCES", "EPERM"].includes(err.code);
    if (isReadonlyFs) {
      // Vercel serverless has a read-only project filesystem. Keep session-local state.
      inMemoryApplicationsData = cloneJson(safeData);
      contextCache.applicationsMtimeMs = 0;
      return;
    }
    throw err;
  }
}

function listApplicationsForApi(rawData) {
  const arr = Array.isArray(rawData?.applications) ? rawData.applications : [];
  return arr
    .filter((app) => app && typeof app === "object")
    .filter((app) => !app._comment)
    .map((app) => sanitizeApplication(app, getStoredAppId(app)))
    .filter((app) => hasMeaningfulApplicationContent(app));
}

async function loadAiSdk() {
  if (aiSdkModules) return aiSdkModules;
  const [{ generateText, streamText }, { createOpenAI }] = await Promise.all([import("ai"), import("@ai-sdk/openai")]);
  const openai = createOpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_BASE_URL
  });
  aiSdkModules = { generateText, streamText, openai };
  return aiSdkModules;
}

async function loadCompanyIntel() {
  if (companyIntelCache) return companyIntelCache;
  if (!fssync.existsSync(COMPANY_INTEL_PATH)) {
    companyIntelCache = [];
    return companyIntelCache;
  }
  const raw = await fs.readFile(COMPANY_INTEL_PATH, "utf8");
  const parsed = safeJsonParse(raw, { companies: [] });
  const companies = Array.isArray(parsed?.companies) ? parsed.companies : [];
  companyIntelCache = companies.filter((c) => c && typeof c === "object");
  return companyIntelCache;
}

function pickModelId(modelProfile) {
  return String(modelProfile || "smart").toLowerCase() === "fast" ? OPENAI_FAST_MODEL : OPENAI_MODEL;
}

function getRelevantCompanies(question, companies, maxItems = 8) {
  const q = String(question || "").trim();
  if (!q) return companies.slice(0, maxItems);
  const ranked = companies
    .map((company) => {
      const combined = `${company.name} ${company.ticker} ${company.sector} ${(company.roles || []).join(" ")} ${company.ai_focus ? "ai" : ""} ${
        company.india_presence ? "india" : ""
      }`;
      return { company, score: scoreTextByQuery(combined, q) };
    })
    .sort((a, b) => b.score - a.score);
  const selected = ranked.filter((item) => item.score > 0).slice(0, maxItems).map((item) => item.company);
  if (selected.length) return selected;
  return companies.slice(0, maxItems);
}

function databaseEnabled() {
  return Boolean(DATABASE_URL);
}

async function ensureDatabase() {
  if (!databaseEnabled()) return false;
  if (pgReadyPromise) return pgReadyPromise;

  pgReadyPromise = (async () => {
    if (!pgPool) {
      let Pool;
      try {
        ({ Pool } = require("pg"));
      } catch {
        throw new Error("DATABASE_URL is set, but 'pg' dependency is missing. Run: npm install");
      }
      pgPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      });
    }

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS applications (
        id text PRIMARY KEY,
        company text NOT NULL DEFAULT '',
        role text NOT NULL DEFAULT '',
        location text NOT NULL DEFAULT '',
        date_applied text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'applied',
        source text NOT NULL DEFAULT '',
        contact_person text NOT NULL DEFAULT '',
        contact_email text NOT NULL DEFAULT '',
        resume_version text NOT NULL DEFAULT '',
        job_url text NOT NULL DEFAULT '',
        follow_up_date text NOT NULL DEFAULT '',
        salary_range text NOT NULL DEFAULT '',
        notes text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    return true;
  })().catch((err) => {
    pgReadyPromise = null;
    throw err;
  });

  return pgReadyPromise;
}

async function dbListApplications() {
  await ensureDatabase();
  const sql = `
    SELECT id, company, role, location, date_applied, status, source, contact_person, contact_email, resume_version,
           job_url, follow_up_date, salary_range, notes
    FROM applications
    ORDER BY
      CASE WHEN date_applied = '' THEN 1 ELSE 0 END,
      date_applied DESC,
      updated_at DESC
  `;
  const { rows } = await pgPool.query(sql);
  return rows.map((row) => sanitizeApplication(row, row.id));
}

async function dbCreateApplication(candidate) {
  await ensureDatabase();
  const app = sanitizeApplication(candidate);
  const sql = `
    INSERT INTO applications (
      id, company, role, location, date_applied, status, source, contact_person, contact_email,
      resume_version, job_url, follow_up_date, salary_range, notes
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    RETURNING id, company, role, location, date_applied, status, source, contact_person, contact_email,
              resume_version, job_url, follow_up_date, salary_range, notes
  `;
  const params = [
    app.id,
    app.company,
    app.role,
    app.location,
    app.date_applied,
    app.status,
    app.source,
    app.contact_person,
    app.contact_email,
    app.resume_version,
    app.job_url,
    app.follow_up_date,
    app.salary_range,
    app.notes
  ];
  const { rows } = await pgPool.query(sql, params);
  return sanitizeApplication(rows[0], rows[0].id);
}

async function dbGetApplicationById(appId) {
  await ensureDatabase();
  const { rows } = await pgPool.query(
    `SELECT id, company, role, location, date_applied, status, source, contact_person, contact_email,
            resume_version, job_url, follow_up_date, salary_range, notes
     FROM applications
     WHERE id = $1`,
    [appId]
  );
  if (!rows.length) return null;
  return sanitizeApplication(rows[0], rows[0].id);
}

async function dbUpdateApplication(appId, mergedInput) {
  const merged = sanitizeApplication(mergedInput, appId);
  const sql = `
    UPDATE applications SET
      company = $2,
      role = $3,
      location = $4,
      date_applied = $5,
      status = $6,
      source = $7,
      contact_person = $8,
      contact_email = $9,
      resume_version = $10,
      job_url = $11,
      follow_up_date = $12,
      salary_range = $13,
      notes = $14,
      updated_at = now()
    WHERE id = $1
    RETURNING id, company, role, location, date_applied, status, source, contact_person, contact_email,
              resume_version, job_url, follow_up_date, salary_range, notes
  `;
  const params = [
    appId,
    merged.company,
    merged.role,
    merged.location,
    merged.date_applied,
    merged.status,
    merged.source,
    merged.contact_person,
    merged.contact_email,
    merged.resume_version,
    merged.job_url,
    merged.follow_up_date,
    merged.salary_range,
    merged.notes
  ];
  const { rows } = await pgPool.query(sql, params);
  return rows.length ? sanitizeApplication(rows[0], rows[0].id) : null;
}

async function dbDeleteApplication(appId) {
  await ensureDatabase();
  const { rowCount } = await pgPool.query("DELETE FROM applications WHERE id = $1", [appId]);
  return rowCount > 0;
}

function extractResumeSignals(resumeText) {
  const text = resumeText || "";
  const email = (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/) || [null])[0];
  const phone = (text.match(/(\+?\d[\d\s-]{8,}\d)/) || [null])[0];

  const skillKeywords = [
    "PCR",
    "ELISA",
    "cloning",
    "CRISPR",
    "Cas9",
    "protein modeling",
    "PyMOL",
    "SWISS-MODEL",
    "BLAST",
    "MEGA12",
    "Clustal",
    "Python",
    "R",
    "AWS",
    "bioinformatics",
    "chromatography",
    "SDS-PAGE",
    "Nipah"
  ];

  const matchedSkills = skillKeywords.filter((skill) => new RegExp(`\\b${escapeRegex(skill)}\\b`, "i").test(text));
  const interests = [];
  if (/n(i|ı)pah/i.test(text)) interests.push("Emerging infectious diseases");
  if (/crispr|cas9/i.test(text)) interests.push("Gene editing");
  if (/microbiome|serotonin/i.test(text)) interests.push("Gut microbiome therapeutics");
  if (/bioinformatics|blast|sequence|genomics/i.test(text)) interests.push("Genomics and computational biology");

  return {
    email: email || "",
    phone: phone || "",
    matched_skills: matchedSkills,
    inferred_interests: [...new Set(interests)]
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function extractPdfText(pdfPath) {
  if (!pdfPath) return "";
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"]);
    return stdout || "";
  } catch {
    return "";
  }
}

function normalizeApplications(rawData) {
  const rawApps = Array.isArray(rawData?.applications) ? rawData.applications : [];
  const cleaned = rawApps
    .filter((app) => app && typeof app === "object")
    .filter((app) => {
      if (app._comment) return false;
      return Object.values(app).some((value) => String(value || "").trim() !== "");
    })
    .map((app) => sanitizeApplication(app, getStoredAppId(app)));

  return {
    applications: cleaned,
    application_advice: rawData?.application_advice || {}
  };
}

function summarizeApplications(applications) {
  const summary = {
    total: applications.length,
    by_status: {},
    top_roles: [],
    top_companies: [],
    top_locations: [],
    pending_follow_ups: 0
  };

  const roleCount = new Map();
  const companyCount = new Map();
  const locationCount = new Map();
  const now = new Date();
  const nowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const app of applications) {
    summary.by_status[app.status] = (summary.by_status[app.status] || 0) + 1;
    if (app.role) roleCount.set(app.role, (roleCount.get(app.role) || 0) + 1);
    if (app.company) companyCount.set(app.company, (companyCount.get(app.company) || 0) + 1);
    if (app.location) locationCount.set(app.location, (locationCount.get(app.location) || 0) + 1);
    if (app.follow_up_date) {
      const d = new Date(`${app.follow_up_date}T00:00:00`);
      if (!Number.isNaN(d.getTime()) && d <= nowDate) summary.pending_follow_ups += 1;
    }
  }

  summary.top_roles = [...roleCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([role, count]) => ({ role, count }));
  summary.top_companies = [...companyCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([company, count]) => ({ company, count }));
  summary.top_locations = [...locationCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([location, count]) => ({ location, count }));

  return summary;
}

function buildProfileSnapshot({ resumeText, applications }) {
  const resumeSignals = extractResumeSignals(resumeText);
  const appSummary = summarizeApplications(applications);
  const nameFromFile = "Smitha Sandrina";

  return {
    name: process.env.CANDIDATE_NAME || nameFromFile,
    location_preference: process.env.PREFERRED_LOCATION || "Bangalore / India / Remote",
    role_focus: process.env.ROLE_FOCUS || "Research Associate, Computational Biology, Bioinformatics, Diagnostics",
    experience_theme: "Molecular biology + bioinformatics + applied AI readiness",
    contact: {
      email: resumeSignals.email,
      phone: resumeSignals.phone
    },
    inferred_strengths: resumeSignals.matched_skills,
    inferred_interests: resumeSignals.inferred_interests,
    application_summary: appSummary
  };
}

async function loadContext() {
  const resumePath = await findResumePath();
  contextCache.resumePath = resumePath;

  if (resumePath) {
    const resumeStat = await fs.stat(resumePath);
    if (resumeStat.mtimeMs !== contextCache.resumeMtimeMs) {
      contextCache.resumeMtimeMs = resumeStat.mtimeMs;
      contextCache.resumeText = await extractPdfText(resumePath);
      contextCache.resumeChunks = chunkText(contextCache.resumeText);
    }
  }

  if (!contextCache.resumeText && fssync.existsSync(RESUME_FALLBACK_PATH)) {
    try {
      const fallbackResume = await fs.readFile(RESUME_FALLBACK_PATH, "utf8");
      if (fallbackResume.trim()) {
        contextCache.resumeText = fallbackResume;
        contextCache.resumeChunks = chunkText(contextCache.resumeText);
      }
    } catch {
      // keep running without fallback resume context
    }
  }

  const rawData = await readApplicationsFileRaw();
  const advice = rawData.application_advice || {};
  let applications = [];
  if (databaseEnabled()) {
    applications = await dbListApplications();
  } else {
    applications = listApplicationsForApi(rawData);
  }
  contextCache.applicationsData = {
    applications,
    application_advice: advice
  };
  const companyIntel = await loadCompanyIntel();
  const resumeSource = contextCache.resumePath
    ? path.basename(contextCache.resumePath)
    : contextCache.resumeText
      ? path.relative(ROOT, RESUME_FALLBACK_PATH)
      : null;

  return {
    resumePath: contextCache.resumePath,
    resumeSource,
    resumeText: contextCache.resumeText,
    resumeChunks: contextCache.resumeChunks,
    companyIntel,
    applicationsData: contextCache.applicationsData,
    profile: buildProfileSnapshot({
      resumeText: contextCache.resumeText,
      applications: contextCache.applicationsData.applications
    })
  };
}

function getRelevantApplications(question, applications, maxItems = 6) {
  const withScore = applications.map((app) => {
    const combined = `${app.company} ${app.role} ${app.location} ${app.status} ${app.notes}`;
    return { app, score: scoreTextByQuery(combined, question) };
  });
  const sorted = withScore
    .sort((a, b) => b.score - a.score)
    .map((item) => item.app);

  const activeFirst = applications
    .filter((app) => ["screening", "interview", "assessment", "offer"].includes(app.status))
    .slice(0, 3);

  const merged = [...activeFirst];
  for (const app of sorted) {
    if (merged.length >= maxItems) break;
    if (!merged.includes(app)) merged.push(app);
  }
  return merged.slice(0, maxItems);
}

function getRelevantResumeChunks(question, chunks, maxItems = 3) {
  const ranked = chunks
    .map((chunk) => ({ chunk, score: scoreTextByQuery(chunk, question) }))
    .sort((a, b) => b.score - a.score);
  const selected = ranked.filter((item) => item.score > 0).slice(0, maxItems).map((item) => item.chunk);
  if (selected.length) return selected;
  return chunks.slice(0, Math.min(maxItems, chunks.length));
}

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "You are Smitha's elite career strategy advisor.",
    `Today's date is ${today}.`,
    "Your purpose: maximize interview conversions and offer outcomes for biotech / computational biology / diagnostics roles.",
    "Use only the user context provided. If data is missing, say what is missing and provide a fallback strategy.",
    "Always tailor advice to current applications, role focus, and inferred strengths/interests.",
    "Output style requirements:",
    "1) Be direct and specific.",
    "2) Give high-leverage, realistic actions for the next 24h and next 7 days.",
    "3) Include concrete wording examples when useful (follow-up message, interview answer framing, resume bullet rewrites).",
    "4) If the request is broad, structure as: Strategy, Immediate Actions, Risks, and Draft Message.",
    "5) Never request API keys or sensitive secrets."
  ].join("\n");
}

function buildModePrompt(mode) {
  const normalized = String(mode || "general").toLowerCase();
  if (normalized === "resume") {
    return "Focus on resume optimization, ATS keyword alignment, and role-specific bullet rewriting.";
  }
  if (normalized === "interview") {
    return "Focus on interview prep: likely questions, answer stories, technical framing, and mock answer improvement.";
  }
  if (normalized === "networking") {
    return "Focus on outreach strategy: concise recruiter messages, referral asks, and follow-up sequencing.";
  }
  if (normalized === "application") {
    return "Focus on application execution: role prioritization, submission quality, and follow-up cadence.";
  }
  return "Focus on highest-ROI career strategy across resume, applications, outreach, and interview readiness.";
}

function buildContextBlock({ profile, relevantApplications, applicationAdvice, relevantResumeChunks, relevantCompanies }) {
  return [
    "Candidate profile:",
    JSON.stringify(profile, null, 2),
    "",
    "Current applications relevant to this request:",
    JSON.stringify(relevantApplications, null, 2),
    "",
    "S&P500 AI/Biotech company intelligence relevant to this request:",
    JSON.stringify(relevantCompanies, null, 2),
    "",
    "Existing application advice preferences/checklists:",
    JSON.stringify(applicationAdvice || {}, null, 2),
    "",
    "Relevant resume excerpts:",
    relevantResumeChunks.join("\n\n---\n\n")
  ].join("\n");
}

function buildPromptMessages({
  message,
  mode,
  sessionHistory,
  profile,
  relevantApplications,
  relevantResumeChunks,
  relevantCompanies,
  applicationAdvice
}) {
  const messages = [];
  messages.push({ role: "system", content: buildSystemPrompt() });
  messages.push({ role: "system", content: buildModePrompt(mode) });
  messages.push({
    role: "user",
    content: buildContextBlock({
      profile,
      relevantApplications,
      applicationAdvice,
      relevantResumeChunks,
      relevantCompanies
    })
  });
  for (const item of sessionHistory.slice(-MAX_HISTORY_MESSAGES)) {
    messages.push({
      role: item.role,
      content: item.content
    });
  }
  messages.push({ role: "user", content: message });
  return messages;
}

async function callOpenAI({
  message,
  mode,
  modelProfile,
  sessionHistory,
  profile,
  relevantApplications,
  relevantCompanies,
  relevantResumeChunks,
  applicationAdvice
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing in .env");
  }
  const { generateText, openai } = await loadAiSdk();
  const maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS || 2200);
  const modelId = pickModelId(modelProfile);
  const messages = buildPromptMessages({
    message,
    mode,
    sessionHistory,
    profile,
    relevantApplications,
    relevantResumeChunks,
    relevantCompanies,
    applicationAdvice
  });
  const result = await generateText({
    model: openai(modelId),
    messages,
    maxOutputTokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 2200
  });
  const text = String(result.text || "").trim();
  if (!text) {
    throw new Error("Model response did not include text output.");
  }
  return { text, modelId };
}

async function streamOpenAIText({
  message,
  mode,
  modelProfile,
  sessionHistory,
  profile,
  relevantApplications,
  relevantCompanies,
  relevantResumeChunks,
  applicationAdvice
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing in .env");
  }
  const { streamText, openai } = await loadAiSdk();
  const maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS || 2200);
  const modelId = pickModelId(modelProfile);
  const messages = buildPromptMessages({
    message,
    mode,
    sessionHistory,
    profile,
    relevantApplications,
    relevantResumeChunks,
    relevantCompanies,
    applicationAdvice
  });
  const result = streamText({
    model: openai(modelId),
    messages,
    maxOutputTokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 2200
  });
  return { textStream: result.textStream, modelId };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(payload);
}

async function readRequestJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error("Request body too large");
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(reqPath, res) {
  const routeAliases = {
    "/": "/index.html",
    "/counseller": "/counseller.html",
    "/tracker": "/tracker.html"
  };
  const resolvedPath = routeAliases[reqPath] || reqPath;
  const filePath = path.join(PUBLIC_DIR, resolvedPath);
  const safePath = path.normalize(filePath);
  if (!safePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(safePath);
    res.writeHead(200, { "Content-Type": getContentType(safePath) });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const reqPath = url.pathname;

  try {
    if (req.method === "GET" && reqPath === "/api/health") {
      const context = await loadContext();
      sendJson(res, 200, {
        ok: true,
        model: OPENAI_MODEL,
        fast_model: OPENAI_FAST_MODEL,
        storage: databaseEnabled() ? "postgres" : "json",
        resume_source: context.resumeSource,
        resume_context_loaded: context.resumeChunks.length > 0,
        applications_loaded: context.applicationsData.applications.length
      });
      return;
    }

    if (req.method === "GET" && reqPath === "/api/profile") {
      const context = await loadContext();
      sendJson(res, 200, {
        profile: context.profile,
        company_intel_count: (context.companyIntel || []).length,
        application_advice: context.applicationsData.application_advice || {},
        applications: context.applicationsData.applications
      });
      return;
    }

    if (req.method === "GET" && reqPath === "/api/applications") {
      const rawData = await readApplicationsFileRaw();
      sendJson(res, 200, {
        applications: databaseEnabled() ? await dbListApplications() : listApplicationsForApi(rawData),
        application_advice: rawData.application_advice || {}
      });
      return;
    }

    if (req.method === "POST" && reqPath === "/api/applications") {
      const body = await readRequestJson(req);
      const candidate = sanitizeApplication(body);
      if (!candidate.company && !candidate.role) {
        sendJson(res, 400, { error: "company or role is required" });
        return;
      }

      if (databaseEnabled()) {
        const created = await dbCreateApplication(candidate);
        sendJson(res, 201, { ok: true, application: created });
        return;
      }

      const rawData = await readApplicationsFileRaw();
      const existing = Array.isArray(rawData.applications) ? rawData.applications : [];
      const kept = existing.filter((entry) => entry && typeof entry === "object" && !entry._comment && hasMeaningfulApplicationContent(entry));
      rawData.applications = [...kept, candidate];
      await writeApplicationsFileRaw(rawData);
      sendJson(res, 201, { ok: true, application: candidate });
      return;
    }

    if ((req.method === "PUT" || req.method === "DELETE") && reqPath.startsWith("/api/applications/")) {
      const appId = decodeURIComponent(reqPath.slice("/api/applications/".length)).trim();
      if (!appId) {
        sendJson(res, 400, { error: "application id is required" });
        return;
      }

      if (databaseEnabled()) {
        if (req.method === "DELETE") {
          const deleted = await dbDeleteApplication(appId);
          if (!deleted) {
            sendJson(res, 404, { error: "application not found" });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        const body = await readRequestJson(req);
        const existing = await dbGetApplicationById(appId);
        if (!existing) {
          sendJson(res, 404, { error: "application not found" });
          return;
        }
        const mergedInput = sanitizeApplication({ ...existing, ...body }, appId);
        if (!mergedInput.company && !mergedInput.role) {
          sendJson(res, 400, { error: "company or role is required" });
          return;
        }
        const updated = await dbUpdateApplication(appId, mergedInput);
        if (!updated) {
          sendJson(res, 404, { error: "application not found" });
          return;
        }
        sendJson(res, 200, { ok: true, application: updated });
        return;
      }

      const rawData = await readApplicationsFileRaw();
      const arr = Array.isArray(rawData.applications) ? rawData.applications : [];
      const index = arr.findIndex((item) => getStoredAppId(item) === appId);
      if (index === -1) {
        sendJson(res, 404, { error: "application not found" });
        return;
      }

      if (req.method === "DELETE") {
        arr.splice(index, 1);
        rawData.applications = arr;
        await writeApplicationsFileRaw(rawData);
        sendJson(res, 200, { ok: true });
        return;
      }

      const body = await readRequestJson(req);
      const merged = sanitizeApplication({ ...arr[index], ...body }, appId);
      if (!merged.company && !merged.role) {
        sendJson(res, 400, { error: "company or role is required" });
        return;
      }
      arr[index] = merged;
      rawData.applications = arr;
      await writeApplicationsFileRaw(rawData);
      sendJson(res, 200, { ok: true, application: merged });
      return;
    }

    if (req.method === "POST" && reqPath === "/api/chat") {
      const body = await readRequestJson(req);
      const message = String(body.message || body.query || "").trim();
      const mode = String(body.mode || "general");
      const modelProfile = String(body.modelProfile || "smart").toLowerCase();
      if (!message) {
        sendJson(res, 400, { error: "message is required" });
        return;
      }

      const context = await loadContext();
      const sessionId = String(body.sessionId || crypto.randomUUID());
      const session = sessions.get(sessionId) || [];
      const relevantApplications = getRelevantApplications(message, context.applicationsData.applications, 6);
      const relevantResumeChunks = getRelevantResumeChunks(message, context.resumeChunks, 3);
      const relevantCompanies = getRelevantCompanies(message, context.companyIntel || [], 8);

      const result = await callOpenAI({
        message,
        mode,
        modelProfile,
        sessionHistory: session,
        profile: context.profile,
        relevantApplications,
        relevantCompanies,
        relevantResumeChunks,
        applicationAdvice: context.applicationsData.application_advice
      });

      const updatedSession = [
        ...session,
        { role: "user", content: message },
        { role: "assistant", content: result.text }
      ].slice(-MAX_HISTORY_MESSAGES);
      sessions.set(sessionId, updatedSession);

      sendJson(res, 200, {
        sessionId,
        answer: result.text,
        meta: {
          model: result.modelId,
          model_profile: modelProfile,
          relevant_applications: relevantApplications.length,
          relevant_companies: relevantCompanies.length,
          resume_context_chunks: relevantResumeChunks.length
        }
      });
      return;
    }

    if (req.method === "POST" && reqPath === "/api/chat/stream") {
      const body = await readRequestJson(req);
      const message = String(body.message || body.query || "").trim();
      const mode = String(body.mode || "general");
      const modelProfile = String(body.modelProfile || "smart").toLowerCase();
      if (!message) {
        sendJson(res, 400, { error: "message is required" });
        return;
      }

      const context = await loadContext();
      const sessionId = String(body.sessionId || crypto.randomUUID());
      const session = sessions.get(sessionId) || [];
      const relevantApplications = getRelevantApplications(message, context.applicationsData.applications, 6);
      const relevantResumeChunks = getRelevantResumeChunks(message, context.resumeChunks, 3);
      const relevantCompanies = getRelevantCompanies(message, context.companyIntel || [], 8);

      try {
        const streamResult = await streamOpenAIText({
          message,
          mode,
          modelProfile,
          sessionHistory: session,
          profile: context.profile,
          relevantApplications,
          relevantCompanies,
          relevantResumeChunks,
          applicationAdvice: context.applicationsData.application_advice
        });

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        });

        res.write(`event: meta\ndata: ${JSON.stringify({
          sessionId,
          model: streamResult.modelId,
          model_profile: modelProfile,
          relevant_applications: relevantApplications.length,
          relevant_companies: relevantCompanies.length,
          resume_context_chunks: relevantResumeChunks.length
        })}\n\n`);

        let fullText = "";
        for await (const chunk of streamResult.textStream) {
          if (!chunk) continue;
          fullText += chunk;
          res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
        }

        const updatedSession = [
          ...session,
          { role: "user", content: message },
          { role: "assistant", content: fullText.trim() }
        ].slice(-MAX_HISTORY_MESSAGES);
        sessions.set(sessionId, updatedSession);

        res.write(`event: done\ndata: ${JSON.stringify({ sessionId })}\n\n`);
        res.end();
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : "Streaming failed" });
          return;
        }
        res.write(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : "Streaming failed" })}\n\n`);
        res.end();
      }
      return;
    }

    if (req.method === "POST" && reqPath === "/api/session/reset") {
      const body = await readRequestJson(req);
      const sessionId = String(body.sessionId || "");
      if (sessionId) sessions.delete(sessionId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(reqPath, res);
      return;
    }

    sendText(res, 404, "Not found");
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : "Unknown server error"
    });
  }
}

if (require.main === module) {
  const server = http.createServer(requestHandler);
  server.listen(PORT, () => {
    console.log(`Career advisor running on http://localhost:${PORT}`);
    if (!OPENAI_API_KEY) {
      console.log("Warning: OPENAI_API_KEY is not set in .env");
    }
    console.log(`Using model: ${OPENAI_MODEL}`);
  });
}

module.exports = requestHandler;
