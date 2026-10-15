// AI search, RAG, KMS/QE and native-audit endpoints for the dashboard.
import { execFile } from "node:child_process";
import { MongoClient } from "mongodb";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(here, "..", "tools");

const VOYAGE_URL = process.env.VOYAGE_URL ||
  ((process.env.VOYAGE_API_KEY || "").startsWith("al-") ? "https://ai.mongodb.com/v1/embeddings" : "https://api.voyageai.com/v1/embeddings");
const VOYAGE_MODEL = process.env.VOYAGE_MODEL || "voyage-4-large";
const PATHS = ["subject", "body", "attachments.ocr.text"];
const PROJ = {
  fileNo: 1, subject: 1, directorate: 1, "attachments.type": 1,
  ocr: { $substrCP: [{ $ifNull: [{ $arrayElemAt: ["$attachments.ocr.text", 0] }, ""] }, 0, 160] },
};
const VEC_PLACEHOLDER = "<1024-dim voyage-4-large embedding of the query text>";

async function embedQuery(text) {
  const t = performance.now();
  const r = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: "query", output_dimension: 1024 }),
  });
  if (!r.ok) throw new Error(`Voyage ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { vector: j.data[0].embedding, ms: +(performance.now() - t).toFixed(1) };
}

function findKey(o, key) {
  if (!o || typeof o !== "object") return undefined;
  if (key in o) return o[key];
  for (const v of Object.values(o)) { const f = findKey(v, key); if (f !== undefined) return f; }
  return undefined;
}

function buildPipeline(mode, q, vector, directorate) {
  const vs = { index: "vec", path: "embedding", queryVector: vector, numCandidates: 200, limit: 10 };
  if (directorate) vs.filter = { directorate };
  const lexical = { $search: { index: "fts", text: { query: q, path: PATHS, ...(mode === "fts" ? { fuzzy: { maxEdits: 1 } } : {}) } } };
  switch (mode) {
    case "fts":
      return [lexical, { $limit: 10 }, { $project: { ...PROJ, score: { $meta: "searchScore" } } }];
    case "vector":
      return [{ $vectorSearch: vs }, { $project: { ...PROJ, score: { $meta: "vectorSearchScore" } } }];
    case "hybrid":
      return [
        { $rankFusion: { input: { pipelines: {
          semantic: [{ $vectorSearch: vs }],
          lexical: [{ $search: { index: "fts", text: { query: q, path: PATHS } } }, { $limit: 10 }],
        } } } },
        { $limit: 10 }, { $project: PROJ },
      ];
    default:
      return null;
  }
}

const show = (pipeline) => JSON.stringify(pipeline, (k, v) => (Array.isArray(v) && v.length > 100 && typeof v[0] === "number" ? VEC_PLACEHOLDER : v), 2);

export function registerAiRoutes(app, { getClient, runKubectl, ns }) {
  const col = () => getClient().db("poc").collection("correspondence");

  app.post("/api/ai/search", async (req, res) => {
    const q = String(req.body?.q || "").trim();
    const mode = String(req.body?.mode || "fts");
    const directorate = req.body?.directorate ? String(req.body.directorate) : undefined;
    if (!q) return res.status(400).json({ error: "q required" });
    try {
      if (mode === "text") {
        const filter = { $text: { $search: q } };
        const proj = { fileNo: 1, subject: 1, directorate: 1, score: { $meta: "textScore" } };
        const t = performance.now();
        const rows = await col().find(filter, { projection: proj }).sort({ score: { $meta: "textScore" } }).limit(10).toArray();
        const ms = +(performance.now() - t).toFixed(1);
        const exp = await col().find(filter).sort({ score: { $meta: "textScore" } }).project({ score: { $meta: "textScore" } }).limit(10).explain("executionStats").catch(() => null);
        const es = exp?.executionStats;
        return res.json({
          mode, query: `db.correspondence.find(\n  { $text: { $search: ${JSON.stringify(q)} } },\n  { score: { $meta: "textScore" } }\n).sort({ score: { $meta: "textScore" } }).limit(10)`,
          clientMs: ms, serverMs: es?.executionTimeMillis ?? null,
          plan: es ? { keysExamined: es.totalKeysExamined, docsExamined: es.totalDocsExamined, returned: es.nReturned } : null,
          index: "subject_text_body_text (legacy text index, runs inside mongod)", hits: rows,
        });
      }
      const embed = mode === "fts" ? null : await embedQuery(q);
      const pipeline = buildPipeline(mode, q, embed?.vector, directorate);
      if (!pipeline) return res.status(400).json({ error: "bad mode" });
      const t = performance.now();
      const rows = await col().aggregate(pipeline).toArray();
      const ms = +(performance.now() - t).toFixed(1);
      let serverMs = null, explainExcerpt = null;
      try {
        const exp = await col().aggregate(pipeline).explain("executionStats");
        serverMs = findKey(exp, "executionTimeMillis") ?? null;
        explainExcerpt = JSON.stringify(exp, (k, v) => (Array.isArray(v) && v.length > 100 && typeof v[0] === "number" ? "[vector]" : v), 1).slice(0, 3500);
      } catch (e) { explainExcerpt = `explain unavailable: ${e.message}`; }
      res.json({
        mode, query: `db.correspondence.aggregate(${show(pipeline)})`,
        embedMs: embed?.ms ?? null, clientMs: ms, serverMs, explainExcerpt,
        index: mode === "fts" ? "fts (Lucene inverted index in mongot)" : mode === "vector" ? "vec (HNSW, 1024-d cosine, scalar quantised, in mongot)" : "vec + fts fused by Reciprocal Rank Fusion",
        hits: rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/ai/ask", async (req, res) => {
    const q = String(req.body?.q || "").trim();
    if (!q) return res.status(400).json({ error: "q required" });
    try {
      const embed = await embedQuery(q);
      const pipeline = [
        { $vectorSearch: { index: "vec", path: "embedding", queryVector: embed.vector, numCandidates: 100, limit: 5 } },
        { $project: {
          fileNo: 1, subject: 1, directorate: 1,
          body: { $substrCP: [{ $ifNull: ["$body", ""] }, 0, 1400] },
          ocrContext: { $substrCP: [{ $ifNull: [{ $arrayElemAt: ["$attachments.ocr.text", 0] }, ""] }, 0, 600] },
          score: { $meta: "vectorSearchScore" },
        } },
      ];
      const t = performance.now();
      const hits = await col().aggregate(pipeline).toArray();
      const retrievalMs = +(performance.now() - t).toFixed(1);
      const context = hits.map((h, i) =>
        `[${i + 1}] fileNo=${h.fileNo} dir=${h.directorate}\nSubject: ${h.subject}\nBody: ${h.body}${h.ocrContext ? "\nScanned attachment (OCR): " + h.ocrContext : ""}`).join("\n\n");
      const prompt = `You are the eOffice assistant for the Indian Air Force. Answer using ONLY the retrieved files below. Cite like [1], [2]. If the answer is not in the files, say so.\n\nRETRIEVED FILES:\n${context}\n\nQUESTION: ${q}\n\nANSWER:`;
      let answer = null, llmMs = null, llmError = null;
      try {
        const t2 = performance.now();
        const r = await fetch(process.env.AI_GATEWAY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
          body: JSON.stringify({ model: process.env.AI_GATEWAY_MODEL || "gpt-5.5", input: prompt }),
          signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) throw new Error(`LLM gateway ${r.status}`);
        const j = await r.json();
        answer = j.output_text ?? (j.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n");
        llmMs = +(performance.now() - t2).toFixed(0);
      } catch (e) { llmError = `${e.message} (LLM gateway needs the reverse tunnel from the corporate network: aws/llm-tunnel.sh)`; }
      res.json({
        question: q, embedMs: embed.ms, retrievalMs, llmMs, answer, llmError,
        query: `db.correspondence.aggregate(${show(pipeline)})`,
        sources: hits.map((h, i) => ({ ref: i + 1, fileNo: h.fileNo, subject: h.subject, directorate: h.directorate, score: +h.score.toFixed(4) })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Queryable Encryption view: runs the tools script (needs crypt_shared + AWS SDK, kept out of the web process)
  app.get("/api/qe/view", (req, res) => {
    const serviceNo = String(req.query.serviceNo || "774411-K");
    const minPay = String(req.query.minPay || "1000000");
    if (!/^[A-Za-z0-9-]{3,20}$/.test(serviceNo) || !/^\d{1,12}$/.test(minPay)) return res.status(400).json({ error: "bad input" });
    execFile("node", ["qe-view.js", "--serviceNo", serviceNo, "--minPay", minPay], { cwd: TOOLS_DIR, timeout: 40000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return res.status(500).json({ error: (stderr || err.message).slice(0, 600) });
      try { res.json(JSON.parse(stdout)); } catch { res.status(500).json({ error: "unparseable output", raw: stdout.slice(0, 300) }); }
    });
  });

  // Native Enterprise audit log, read from the PRIMARY pod
  app.post("/api/audit/failed-login", async (_req, res) => {
    const uri = process.env.MONGO_URL.replace(/\/\/[^@]*@/, "//intruder:wrong-password@");
    const bad = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
    try {
      await bad.db("admin").command({ ping: 1 });
      res.status(500).json({ error: "unexpected: bad credentials were accepted" });
    } catch (e) {
      res.json({ message: `Login as "intruder" rejected (${e.codeName || e.message}). Reload the native audit events to see the authenticate event.` });
    } finally { await bad.close().catch(() => {}); }
  });

  // Native Enterprise audit log, read from the PRIMARY pod
  app.get("/api/audit/native", async (_req, res) => {
    try {
      const hello = await getClient().db("admin").command({ hello: 1 });
      const pod = String(hello.primary).split(".")[0];
      if (!/^eoffice-rs-\d+$/.test(pod)) return res.status(400).json({ error: "native audit view is only available on Kubernetes" });
      const [{ stdout }, opts] = await Promise.all([
        runKubectl(["-n", ns, "exec", pod, "--", "tail", "-n", "400", "/var/log/mongodb-mms-automation/audit.json"]),
        getClient().db("admin").command({ getCmdLineOpts: 1 }),
      ]);
      const events = stdout.trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .filter(e => e.atype !== "authCheck" || /poc\.(audit_log|personnel)/.test(JSON.stringify(e.param || {})))
        .slice(-20).reverse()
        .map(e => ({ ts: e.ts?.$date, type: e.atype, user: (e.users || []).map(u => u.user).join(",") || "-", remote: e.remote?.ip, result: e.result, param: e.param }));
      res.json({ pod, auditConfig: opts.parsed?.auditLog ?? null, events });
    } catch (e) { res.status(500).json({ error: e.stderr || e.message }); }
  });
}
