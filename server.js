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
const PORT = Number(process.env.PORT || 3010);

loadDotEnv(ENV_PATH);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MAX_HISTORY_MESSAGES = 12;
const sessions = new Map();
let inMemoryApplicationsData = null;
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

  if (inMemoryApplicationsData) {
    contextCache.applicationsData = normalizeApplications(inMemoryApplicationsData);
  } else if (fssync.existsSync(APPLICATIONS_PATH)) {
    const appStat = await fs.stat(APPLICATIONS_PATH);
    if (appStat.mtimeMs !== contextCache.applicationsMtimeMs) {
      contextCache.applicationsMtimeMs = appStat.mtimeMs;
      const raw = await fs.readFile(APPLICATIONS_PATH, "utf8");
      const parsed = safeJsonParse(raw, { applications: [], application_advice: {} });
      contextCache.applicationsData = normalizeApplications(parsed);
    }
  }

  return {
    resumePath: contextCache.resumePath,
    resumeText: contextCache.resumeText,
    resumeChunks: contextCache.resumeChunks,
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

async function callOpenAI({
  message,
  mode,
  sessionHistory,
  profile,
  relevantApplications,
  relevantResumeChunks,
  applicationAdvice
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing in .env");
  }
  const maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS || 2200);
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || "minimal";

  const input = [];
  input.push({ role: "system", content: [{ type: "input_text", text: buildSystemPrompt() }] });
  input.push({ role: "system", content: [{ type: "input_text", text: buildModePrompt(mode) }] });
  input.push({
    role: "user",
    content: [
      {
        type: "input_text",
        text: [
          "Candidate profile:",
          JSON.stringify(profile, null, 2),
          "",
          "Current applications relevant to this request:",
          JSON.stringify(relevantApplications, null, 2),
          "",
          "Existing application advice preferences/checklists:",
          JSON.stringify(applicationAdvice || {}, null, 2),
          "",
          "Relevant resume excerpts:",
          relevantResumeChunks.join("\n\n---\n\n")
        ].join("\n")
      }
    ]
  });

  for (const item of sessionHistory.slice(-MAX_HISTORY_MESSAGES)) {
    input.push({
      role: item.role,
      content: [{ type: "input_text", text: item.content }]
    });
  }

  input.push({
    role: "user",
    content: [{ type: "input_text", text: message }]
  });

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: reasoningEffort },
    input,
    max_output_tokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 2200
  };

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) {
    throw new Error("Model response did not include text output.");
  }
  return { text, raw: data };
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const output = Array.isArray(data.output) ? data.output : [];
  const parts = [];
  for (const item of output) {
    if (item?.type === "reasoning" && Array.isArray(item.summary)) {
      for (const summaryPart of item.summary) {
        if (typeof summaryPart?.text === "string" && summaryPart.text.trim()) {
          parts.push(summaryPart.text);
        }
      }
    }

    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" || c?.type === "text" || c?.type === "summary_text") {
        if (typeof c.text === "string" && c.text.trim()) {
          parts.push(c.text);
          continue;
        }
        if (c?.text && typeof c.text.value === "string" && c.text.value.trim()) {
          parts.push(c.text.value);
          continue;
        }
      }
      if (c?.type === "refusal" && typeof c.refusal === "string" && c.refusal.trim()) {
        parts.push(c.refusal);
      }
    }
  }
  return parts.join("\n").trim();
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
        resume_path: context.resumePath ? path.basename(context.resumePath) : null,
        applications_loaded: context.applicationsData.applications.length
      });
      return;
    }

    if (req.method === "GET" && reqPath === "/api/profile") {
      const context = await loadContext();
      sendJson(res, 200, {
        profile: context.profile,
        application_advice: context.applicationsData.application_advice || {},
        applications: context.applicationsData.applications
      });
      return;
    }

    if (req.method === "GET" && reqPath === "/api/applications") {
      const rawData = await readApplicationsFileRaw();
      sendJson(res, 200, {
        applications: listApplicationsForApi(rawData),
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
      const message = String(body.message || "").trim();
      const mode = String(body.mode || "general");
      if (!message) {
        sendJson(res, 400, { error: "message is required" });
        return;
      }

      const context = await loadContext();
      const sessionId = String(body.sessionId || crypto.randomUUID());
      const session = sessions.get(sessionId) || [];
      const relevantApplications = getRelevantApplications(message, context.applicationsData.applications, 6);
      const relevantResumeChunks = getRelevantResumeChunks(message, context.resumeChunks, 3);

      const result = await callOpenAI({
        message,
        mode,
        sessionHistory: session,
        profile: context.profile,
        relevantApplications,
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
          model: OPENAI_MODEL,
          relevant_applications: relevantApplications.length,
          resume_context_chunks: relevantResumeChunks.length
        }
      });
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
