// Proxy a Azure AI Foundry Agent Service (threads/runs/messages)
// Auth: Microsoft Entra ID con Managed Identity (DefaultAzureCredential)
// App Settings requeridos: FOUNDRY_PROJECT_ENDPOINT, AGENT_ID
// Opcionales: CORS_ORIGIN, TIMEOUT_MS
//
// Referencias:
// - Agents API (REST, Entra ID + RBAC, sin keys): https://learn.microsoft.com/en-us/rest/api/aifoundry/aiagents/
// - Conceptos Threads/Runs/Messages: https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/threads-runs-messages

const { DefaultAzureCredential } = require("@azure/identity");
const fetch = global.fetch;

const PROJECT_ENDPOINT = "https://oscarmedagent.services.ai.azure.com/api/projects/firstProject";
const AGENT_ID        = "asst_HXm8O6Gr5D02ePXt1d2N3xsq";

const ALLOWED_ORIGIN  = process.env.CORS_ORIGIN || "*";
const API_VERSION     = "v1";
const TIMEOUT_MS      = parseInt(process.env.TIMEOUT_MS || "60000", 10);
const SCOPE           = "https://ai.azure.com/.default"; // scope para Foundry Agents
// --------- utilidades de log/seguridad ----------
function sanitizeEndpoint(ep) {
  try {
    const u = new URL(ep);
    // Logueamos host y el "project-name" (último segmento) sin exponer IDs completos
    const parts = u.pathname.split("/").filter(Boolean); // ["api","projects","<project-name>"]
    const projectName = parts[2] || "<unknown>";
    return { host: u.host, project: projectName, path: "/api/projects/<redacted>" };
  } catch {
    return { host: "<invalid>", project: "<invalid>", path: "<invalid>" };
  }
}

function missingSettings() {
  const need = [];
  if (!PROJECT_ENDPOINT) need.push("FOUNDRY_PROJECT_ENDPOINT");
  if (!AGENT_ID)         need.push("AGENT_ID");
  return need;
}

// --------- identidad y http ----------
async function getBearerToken() {
  const cred = new DefaultAzureCredential();
  const { token } = await cred.getToken(SCOPE);
  return token;
}

async function httpJson(method, url, body, bearer, context) {
  const headers = {
    "Authorization": `Bearer ${bearer}`,
    "Content-Type": "application/json"
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep raw text for error data */ }

  // Log de nivel bajo (sin secretos)
  context.log(`[${method}] ${url} -> ${res.status}`);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data || text || null;
    throw err;
  }
  return data;
}

async function pollRun(threadId, runId, bearer, timeoutMs, context) {
  const url = `${PROJECT_ENDPOINT}/threads/${threadId}/runs/${runId}?api-version=${API_VERSION}`;
  const start = Date.now();
  for (;;) {
    const run = await httpJson("GET", url, null, bearer, context);
    const st = run.status;
    context.log(`poll run ${runId} => ${st}`);
    if (["completed","failed","cancelled","expired"].includes(st)) return run;
    if (Date.now() - start > timeoutMs) {
      const e = new Error("Timeout esperando el run");
      e.status = 504;
      throw e;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

function lastAssistantText(listMessagesResponse) {
  const arr = (listMessagesResponse && listMessagesResponse.data) || [];
  let m = arr.find(x => x.role === "assistant") || [...arr].reverse().find(x => x.role === "assistant");
  if (!m) return null;
  const node = m.content?.find(c => c.type === "text");
  return node?.text?.value ?? node?.value ?? null;
}

// --------- handler principal ----------
module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    context.res = {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    };
    return;
  }

  // Log inicial no sensible
  const epSafe = sanitizeEndpoint(PROJECT_ENDPOINT);
  context.log("invocationId:", context.invocationId);
  context.log("cfg:", {
    endpointSet: !!PROJECT_ENDPOINT,
    agentSet: !!AGENT_ID,
    endpointHost: epSafe.host,
    project: epSafe.project,
    timeoutMs: TIMEOUT_MS
  });

  // --- Health check: ?health=1  => solo prueba de token (sin tocar el Project) ---
  if (req.query && req.query.health === "1") {
    try {
      context.log("health: attempting token acquisition...");
      const bearer = await getBearerToken();
      context.log("health: token acquired:", !!bearer);
      context.res = {
        status: 200,
        headers: { "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
        body: { tokenAcquired: !!bearer }
      };
      return;
    } catch (e) {
      context.log("health error:", String(e));
      context.res = {
        status: 500,
        headers: { "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
        body: { error: "token_failed", details: String(e) }
      };
      return;
    }
  }

  // --- Diagnóstico de configuración: ?diag=1 (booleans, sin secretos) ---
  if (req.query && req.query.diag === "1") {
    context.res = {
      status: 200,
      headers: { "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
      body: {
        endpointSet: !!PROJECT_ENDPOINT,
        agentSet: !!AGENT_ID,
        endpointHost: epSafe.host,
        project: epSafe.project,
        timeoutMs: TIMEOUT_MS
      }
    };
    return;
  }

  // Validación de app settings
  const missing = missingSettings();
  if (missing.length) {
    context.log("missing app settings:", missing);
    context.res = {
      status: 500,
      headers: { "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
      body: { error: `Faltan App Settings: ${missing.join(", ")}` }
    };
    return;
  }

  try {
    // Body mínimo requerido
    const { prompt, threadId } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      context.res = {
        status: 400,
        headers: { "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
        body: { error: "Body inválido: se requiere 'prompt' (string)." }
      };
      return;
    }

    // Token MI
    context.log("acquiring token for scope", SCOPE);
    const bearer = await getBearerToken();
    context.log("token ok:", !!bearer);

    let effectiveThreadId = threadId || null;
    let runId;

    if (!effectiveThreadId) {
      // Primer turno: Create Thread and Run
      const url = `${PROJECT_ENDPOINT}/threads/runs?api-version=${API_VERSION}`;
      const body = {
        assistant_id: AGENT_ID,                              // no sobreescribimos instructions
        thread: { messages: [{ role: "user", content: prompt }] }
      };
      context.log("create thread+run...");
      const resp = await httpJson("POST", url, body, bearer, context);
      effectiveThreadId = resp.thread_id || resp.thread?.id;
      runId             = resp.id || resp.run_id || resp.run?.id;
      context.log("thread:", effectiveThreadId, "run:", runId);
    } else {
      // Turnos siguientes: add message + create run
      const addMsgUrl = `${PROJECT_ENDPOINT}/threads/${effectiveThreadId}/messages?api-version=${API_VERSION}`;
      context.log("add message to thread:", effectiveThreadId);
      await httpJson("POST", addMsgUrl, { role: "user", content: prompt }, bearer, context);

      const runUrl = `${PROJECT_ENDPOINT}/threads/${effectiveThreadId}/runs?api-version=${API_VERSION}`;
      context.log("create run on thread:", effectiveThreadId);
      const r = await httpJson("POST", runUrl, { assistant_id: AGENT_ID }, bearer, context);
      runId = r.id || r.run_id || r.run?.id;
      context.log("run:", runId);
    }

    // Poll hasta estado terminal
    const runState = await pollRun(effectiveThreadId, runId, bearer, TIMEOUT_MS, context);

    // Último mensaje del asistente
    const msgsUrl = `${PROJECT_ENDPOINT}/threads/${effectiveThreadId}/messages?api-version=${API_VERSION}`;
    const msgs = await httpJson("GET", msgsUrl, null, bearer, context);
    const output = lastAssistantText(msgs) || "(sin salida)";

    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN
      },
      body: { status: runState.status, threadId: effectiveThreadId, runId, output }
    };
  } catch (e) {
    // Log de error no sensible
    context.log("ERROR:", e.status || "?", String(e));
    if (e && e.data) {
      try {
        const sample = typeof e.data === "string" ? e.data.slice(0, 800) : JSON.stringify(e.data).slice(0, 800);
        context.log("ERROR data:", sample);
      } catch { /* ignore */ }
    }
    context.res = {
      status: e.status || 500,
      headers: { "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
      body: { error: String(e), details: e.data || null }
    };
  }
};