import express from "express";
import { exec, execFile, fork } from "child_process";
import { MongoClient, ReadPreference } from "mongodb";
import path from "path";
import { promisify } from "node:util";
import { fileURLToPath } from "url";
import { registerAiRoutes } from "./ai.js";
import { registerWorkflowRoutes } from "./workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const runKubectl = (args) => execFileAsync(process.env.KUBECTL_PATH || "kubectl", args, {
  timeout: 12000,
  maxBuffer: 2 * 1024 * 1024,
});

const ADMIN_USER = process.env.MONGO_USER || "admin";
const ADMIN_PASS = process.env.MONGO_PASS || "eoffice123";
const MONGO_NS = process.env.MONGO_NAMESPACE || "mongodb";
const RS_NAME = process.env.RS_NAME || "eoffice-rs";
const OPS_MANAGER_URL = process.env.OPS_MANAGER_URL || "";
// "kubernetes" when MCK runs the replica set, "atlas" for an SRV string, else local docker
const DEPLOYMENT = process.env.DEPLOYMENT_MODE ||
  (/svc\.cluster\.local/.test(process.env.MONGO_URL || "") ? "kubernetes"
    : /mongodb\+srv/.test(process.env.MONGO_URL || "") ? "atlas" : "docker");
const ATLAS = DEPLOYMENT === "atlas";
const K8S = DEPLOYMENT === "kubernetes";

const NODES = [
  { name: "dc1-a", region: "DC1", host: "host.docker.internal:27101", container: "eoffice-dc1-a" },
  { name: "dc1-b", region: "DC1", host: "host.docker.internal:27102", container: "eoffice-dc1-b" },
  { name: "dc2-a", region: "DC2", host: "host.docker.internal:27201", container: "eoffice-dc2-a" },
  { name: "dc2-b", region: "DC2", host: "host.docker.internal:27202", container: "eoffice-dc2-b" },
  { name: "dr-a",  region: "DR",  host: "host.docker.internal:27301", container: "eoffice-dr-a" },
];

const RS_URI = process.env.MONGO_URL ||
  `mongodb://${ADMIN_USER}:${ADMIN_PASS}@${NODES.map(n => n.host).join(",")}/?replicaSet=rs0&authSource=admin&retryWrites=true`;
const AUDIT_URI = process.env.AUDIT_URL ||
  `mongodb://audituser:audit123@${NODES.map(n => n.host).join(",")}/?replicaSet=rs0&authSource=admin`;
let client = new MongoClient(RS_URI, { serverSelectionTimeoutMS: 8000, heartbeatFrequencyMS: 500 });
const poc = () => client.db("poc");
// Status polling must never wait for a primary: any live member can answer replSetGetStatus.
const statusClient = new MongoClient(RS_URI, { serverSelectionTimeoutMS: 1500, heartbeatFrequencyMS: 500, readPreference: "secondaryPreferred" });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const stats = (durations) => {
  const s = [...durations].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    ops: s.length,
    avgMs: +(sum / s.length).toFixed(3),
    p50Ms: +pct(s, 50).toFixed(3),
    p95Ms: +pct(s, 95).toFixed(3),
    p99Ms: +pct(s, 99).toFixed(3),
    maxMs: +s[s.length - 1].toFixed(3),
  };
};

async function explainFileNoLookup(col, fileNo) {
  const exp = await col.find({ fileNo }).limit(1).explain("executionStats");
  const winning = exp.queryPlanner?.winningPlan;
  let stage = winning;
  while (stage?.inputStage) stage = stage.inputStage;
    const result = {
    query: `db.correspondence.findOne({ fileNo: ${JSON.stringify(fileNo)} })`,
    plan: stage?.stage || winning?.stage || null,
    indexUsed: stage?.indexName || null,
    executionTimeMillis: exp.executionStats?.executionTimeMillis ?? null,
    totalKeysExamined: exp.executionStats?.totalKeysExamined ?? null,
    totalDocsExamined: exp.executionStats?.totalDocsExamined ?? null,
    nReturned: exp.executionStats?.nReturned ?? null,
  };
    return result;
}

  function directMemberUri(uri, member) {
    const match = uri.match(/^(mongodb:\/\/[^@]+@)[^/]+(\/[^?]*)?(?:\?(.*))?$/);
    if (!match) throw new Error("Read-load profiling requires an authenticated mongodb:// URI");
    const params = new URLSearchParams(match[3] || "");
    params.set("authSource", params.get("authSource") || "admin");
    params.set("directConnection", "true");
    params.delete("replicaSet");
    return `${match[1]}${member}${match[2] || "/"}?${params}`;
  }

  const readLoadRuns = new Map();
  let activeProfiledReadRun = null;
  const PROFILE_SAMPLE_EVERY = 100;
  const LIVE_LATENCY_SAMPLE_SIZE = 20000;

  function addReservoirSample(samples, value, seen) {
    if (samples.length < LIVE_LATENCY_SAMPLE_SIZE) samples.push(value);
    else {
      const slot = Math.floor(Math.random() * seen);
      if (slot < LIVE_LATENCY_SAMPLE_SIZE) samples[slot] = value;
    }
  }

  function percentileSummary(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const at = (p) => +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(4);
    return { ops: s.length, p50Ms: at(50), p95Ms: at(95), p99Ms: at(99), maxMs: +s[s.length - 1].toFixed(4) };
  }

  async function captureProfilerSamples(run) {
    for (const member of run.members) {
      const col = member.client.db("poc").collection("system.profile");
      const rows = await col.find({ appName: run.profileAppName, ns: "poc.correspondence" })
        .sort({ ts: 1 }).limit(2000).toArray();
      for (const row of rows) {
          const id = `${member.name}|${row.ts?.toISOString?.() || ""}|${row.command?.filter?.fileNo || ""}`;
        if (run.profileIds.has(id)) continue;
        run.profileIds.add(id);
        // `millis` is whole ms (sub-ms reads show 0); `micros` and `cpuNanos` keep microsecond resolution
        const elapsedMs = Number.isFinite(row.micros) ? row.micros / 1000 : Number(row.millis ?? 0);
        const workingMs = Number.isFinite(row.cpuNanos) ? row.cpuNanos / 1e6 : Number(row.workingMillis ?? elapsedMs);
        addReservoirSample(run.serverElapsedSamples, elapsedMs, run.profileIds.size);
        addReservoirSample(run.serverWorkingSamples, workingMs, run.profileIds.size);
        if (Number.isFinite(row.keysExamined)) run.keysExamined += row.keysExamined;
        if (Number.isFinite(row.docsExamined)) run.docsExamined += row.docsExamined;
        if (row.planSummary) run.planSummaries[row.planSummary] = (run.planSummaries[row.planSummary] || 0) + 1;
      }
    }
    run.profiledOperations = run.profileIds.size;
  }

  function readLoadSnapshot(run) {
    const elapsedSec = run.state === "complete" || run.state === "failed"
      ? run.durationSec
      : Math.max((performance.now() - (run.startedAtMono ?? performance.now())) / 1000, 0.001);
    const serverSamplePercent = run.completed ? +(run.profiledOperations / run.completed * 100).toFixed(2) : 0;
    return {
      runId: run.id,
      state: run.state,
      durationSec: run.durationSec,
      targetTps: run.targetTps,
      maxConcurrentUsers: run.maxUsers,
      sampleEvery: PROFILE_SAMPLE_EVERY,
      workers: run.workers ?? null,
      targets: run.targets ?? null,
      query: `db.correspondence.findOne({ fileNo: "<random sampled fileNo>" })`,
      readPreference: run.readPreference,
      index: "fileNo_1",
      offered: run.offered,
      started: run.started,
      completed: run.completed,
      errors: run.errors,
      droppedForUserCap: run.droppedForUserCap,
      inFlight: run.inFlight,
      peakInFlight: run.peakInFlight,
      achievedTps: +(run.completed / elapsedSec).toFixed(1),
      clientOperationMs: percentileSummary(run.clientSamples),
      mongoServerElapsedMs: percentileSummary(run.serverElapsedSamples),
      mongoWorkingMs: percentileSummary(run.serverWorkingSamples),
      profiledOperations: run.profiledOperations,
      serverSamplePercent,
      serverPercentilesReliable: run.profiledOperations >= 100,
      keysExamined: run.keysExamined,
      docsExamined: run.docsExamined,
      planSummaries: run.planSummaries,
      note: "Server times come from sampled system.profile records at microsecond resolution (elapsed = micros, CPU = cpuNanos). Elapsed is time inside mongod from command start to finish; it excludes network and driver time, so it is below the client-observed time.",
    };
  }

const SUBJ_WORDS = ["Procurement", "Posting", "Leave", "Training", "Audit", "Budget", "Security", "Upgrade", "Maintenance", "Policy", "Inspection", "Deployment"];
const DIRS = ["Ops", "Maint", "Admin", "Plans", "CIT", "Trg", "Works", "Accts"];
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- Pre-aggregated counters (O(1) counts for the registry) ----------
async function rebuildCounters() {
  const rows = await poc().collection("correspondence").aggregate([
    { $group: { _id: { d: "$directorate", s: "$status" }, n: { $sum: 1 } } },
    { $match: { "_id.d": { $ne: null }, "_id.s": { $ne: null } } },
  ]).toArray();
  const counters = poc().collection("counters");
  await counters.deleteMany({});
  if (rows.length) await counters.insertMany(rows.map(r => ({ _id: `${r._id.d}|${r._id.s}`, directorate: r._id.d, status: r._id.s, n: r.n })));
  return rows.length;
}

// change streams keep counters exact when files change status / get destroyed (BOO)
function startCounterWatcher() {
  const counters = poc().collection("counters");
  const inc = (d, s, delta) => d && s && counters.updateOne(
    { _id: `${d}|${s}` },
    { $inc: { n: delta }, $setOnInsert: { directorate: d, status: s } },
    { upsert: true }
  ).catch(() => {});
  const stream = poc().collection("correspondence").watch(
    [{ $match: { operationType: { $in: ["update", "delete", "replace"] } } }],
    { fullDocument: "updateLookup", fullDocumentBeforeChange: "whenAvailable" }
  );
  stream.on("change", (ev) => {
    const b = ev.fullDocumentBeforeChange, a = ev.fullDocument;
    if (ev.operationType === "delete") inc(b?.directorate, b?.status, -1);
    else if (b && a && (b.status !== a.status || b.directorate !== a.directorate)) {
      inc(b.directorate, b.status, -1);
      inc(a.directorate, a.status, 1);
    }
  });
  stream.on("error", () => setTimeout(startCounterWatcher, 5000));
}

app.get("/api/mode", (_req, res) => res.json({
  deployment: DEPLOYMENT,
  atlas: ATLAS,
  kubernetes: K8S,
  connected,
  replicaSet: RS_NAME,
  opsManagerUrl: OPS_MANAGER_URL,
  failoverApi: !!(process.env.ATLAS_PUBLIC_KEY && process.env.ATLAS_PRIVATE_KEY && process.env.ATLAS_GROUP_ID && process.env.ATLAS_CLUSTER),
}));

// ---------- Topology / replication lag ----------
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

// Pod lifecycle straight from the kubelet — changes the instant a pod is deleted, unlike the replica-set view.
async function podStates() {
  const { stdout } = await runKubectl(["-n", MONGO_NS, "get", "pods", "-o", "json"]);
  return Object.fromEntries(JSON.parse(stdout).items
    .filter(p => new RegExp(`^${RS_NAME}-\\d+$`).test(p.metadata.name))
    .map(p => {
      const mongod = (p.status.containerStatuses || []).find(c => c.name !== "mongodb-agent" && c.name !== "mongodb-agent-monitoring") || {};
      return [p.metadata.name, {
        phase: p.metadata.deletionTimestamp ? "Terminating" : p.status.phase,
        ready: !!mongod.ready && !p.metadata.deletionTimestamp,
        restarts: mongod.restartCount ?? 0,
      }];
    }));
}

app.get("/api/status", async (_req, res) => {
  const [rsR, podR] = await Promise.allSettled([
    withTimeout((async () => {
      const adminDb = statusClient.db("admin");
      const st = await adminDb.command({ replSetGetStatus: 1 });
      // replSetGetConfig is blocked on Atlas — fall back gracefully
      let cfgByHost = {};
      try {
        const cfg = await adminDb.command({ replSetGetConfig: 1 });
        cfgByHost = Object.fromEntries(cfg.config.members.map(m => [m.host, m]));
      } catch { /* Atlas: no config access */ }
      return { st, cfgByHost };
    })(), 2500),
    K8S ? withTimeout(podStates(), 2500) : Promise.resolve({}),
  ]);
  const pods = podR.status === "fulfilled" ? podR.value : {};

  if (rsR.status === "rejected" && !Object.keys(pods).length) return res.status(500).json({ error: rsR.reason.message });

  let members = [];
  let primaryName = null;
  let setName = RS_NAME;
  let source = "replica set + kubelet";
  if (rsR.status === "fulfilled") {
    const { st, cfgByHost } = rsR.value;
    setName = st.set;
    const primary = st.members.find(m => m.stateStr === "PRIMARY");
    members = st.members.map(m => {
      const c = cfgByHost[m.name] || {};
      const node = NODES.find(n => n.host === m.name)?.name || m.name.split(".")[0];
      const pod = pods[node];
      const gone = pod && (pod.phase === "Terminating");
      return {
        host: m.name, node,
        region: c.tags?.region || (ATLAS ? "atlas" : K8S ? "k8s" : "?"),
        state: gone ? "TERMINATING" : m.stateStr,
        health: gone ? 0 : m.health,
        pod: pod?.phase ?? null,
        priority: c.priority, votes: c.votes,
        pingMs: m.pingMs ?? null,
        replicationLagSec: primary && m.optimeDate && primary.optimeDate ? Math.max(0, (primary.optimeDate - m.optimeDate) / 1000) : null,
        uptimeSec: m.uptime,
      };
    });
    primaryName = members.find(m => m.state === "PRIMARY")?.host || null;
  } else {
    // replica set unreachable (election / all forwards down): show what the kubelet knows
    source = "kubelet only (replica set unreachable)";
    members = Object.entries(pods).map(([node, p]) => ({
      host: node, node, region: "k8s",
      state: p.phase === "Terminating" ? "TERMINATING" : p.ready ? "UNKNOWN" : "STARTING",
      health: p.ready ? 1 : 0, pod: p.phase,
    }));
  }
  res.json({ set: setName, primary: primaryName, members, source });
});

app.get("/api/kubernetes/metrics", async (_req, res) => {
  try {
    const [nodesResult, podsResult] = await Promise.all([
      runKubectl(["get", "nodes", "-o", "json"]),
      runKubectl(["get", "pods", "-n", "mongodb", "-o", "json"]),
    ]);
    const [nodeTop, podTop] = await Promise.allSettled([
      runKubectl(["top", "nodes", "--no-headers"]),
      runKubectl(["top", "pods", "-n", "mongodb", "--no-headers"]),
    ]);
    const parseRows = (result) => result.status === "fulfilled"
      ? result.value.stdout.trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/))
      : [];
    const nodeUsage = new Map(parseRows(nodeTop).map(([name, cpu, cpuPercent, memory, memoryPercent]) => [name, {
      cpu, cpuPercent, memory, memoryPercent,
    }]));
    const podUsage = new Map(parseRows(podTop).map(([name, cpu, memory]) => [name, { cpu, memory }]));
    const nodes = JSON.parse(nodesResult.stdout).items.map(node => ({
      name: node.metadata.name,
      ready: node.status.conditions?.find(condition => condition.type === "Ready")?.status === "True",
      capacity: node.status.capacity,
      allocatable: node.status.allocatable,
      metrics: nodeUsage.get(node.metadata.name) || null,
    }));
    const pods = JSON.parse(podsResult.stdout).items.map(pod => {
      const containerStatuses = pod.status.containerStatuses || [];
      return {
        name: pod.metadata.name,
        phase: pod.status.phase || "Unknown",
        ready: containerStatuses.length > 0 && containerStatuses.every(container => container.ready),
        restarts: containerStatuses.reduce((total, container) => total + container.restartCount, 0),
        node: pod.spec.nodeName || null,
        startedAt: pod.status.startTime || null,
        metrics: podUsage.get(pod.metadata.name) || null,
      };
    });
    const metricErrors = [nodeTop, podTop].filter(result => result.status === "rejected").map(result => result.reason.message);
    res.json({ timestamp: new Date().toISOString(), namespace: "mongodb", nodes, pods, metricsAvailable: metricErrors.length === 0, metricsError: metricErrors.join("; ") || null });
  } catch (error) {
    res.status(503).json({ error: error.message, timestamp: new Date().toISOString() });
  }
});

// ---------- Seed ----------
app.post("/api/seed", async (req, res) => {
  const count = Math.min(Number(req.body?.count) || 100000, 2000000);
  const col = poc().collection("correspondence");
  const t0 = Date.now();
  let inserted = 0;
  const batchSize = 5000;
  try {
    // self-heal: indexes survive even if the collection was dropped for a reset
    await col.createIndex({ fileNo: 1 });
    await col.createIndex({ directorate: 1, status: 1, createdAt: -1 });
    await col.createIndex({ subject: "text", body: "text" });
    await col.createIndex({ createdAt: -1 });
    // partial indexes: tiny, hot-subset indexes for the MFIR working set
    await col.createIndex({ createdAt: -1 }, { name: "open_recent_partial", partialFilterExpression: { status: "OPEN" } });
    await col.createIndex({ createdAt: -1 }, { name: "pending_recent_partial", partialFilterExpression: { status: "PENDING" } });
    await col.createIndex({ createdAt: -1 }, { name: "closed_recent_partial", partialFilterExpression: { status: "CLOSED" } });
    // continue numbering after existing docs so fileNos stay unique across seed runs
    const start = await col.estimatedDocumentCount();
    const tally = {}; // (directorate|status) -> n, flushed to counters after insert
    for (let i = start; i < start + count; i += batchSize) {
      const batch = [];
      for (let j = i; j < Math.min(i + batchSize, start + count); j++) {
        const directorate = rand(DIRS), status = rand(["OPEN", "PENDING", "CLOSED"]);
        tally[`${directorate}|${status}`] = (tally[`${directorate}|${status}`] || 0) + 1;
        batch.push({
          fileNo: `AIRHQ/C 17500/${j}/UDAAN`,
          subject: `${rand(SUBJ_WORDS)} ${rand(SUBJ_WORDS)} case ${j}`,
          body: `Correspondence regarding ${rand(SUBJ_WORDS).toLowerCase()} raised by ${directorate} directorate. Ref ${j}.`,
          directorate,
          status,
          priority: rand(["NORMAL", "URGENT", "TOP"]),
          createdAt: new Date(Date.now() - Math.random() * 365 * 864e5),
        });
      }
      await col.insertMany(batch, { ordered: false, writeConcern: { w: 1 } });
      inserted += batch.length;
    }
    await poc().collection("counters").bulkWrite(Object.entries(tally).map(([k, n]) => {
      const [directorate, status] = k.split("|");
      return { updateOne: { filter: { _id: k }, update: { $inc: { n }, $setOnInsert: { directorate, status } }, upsert: true } };
    }));
    const total = await col.estimatedDocumentCount();
    res.json({ inserted, totalDocs: total, seconds: +((Date.now() - t0) / 1000).toFixed(1) });
  } catch (e) {
    res.status(500).json({ error: e.message, inserted });
  }
});

// ---------- P99 latency (reads or writes) ----------
app.post("/api/latency", async (req, res) => {
  const mode = req.body?.mode === "write" ? "write" : "read";
  const readPattern = req.body?.readPattern === "hot" ? "hot" : "random";
  const ops = Math.min(Number(req.body?.ops) || 2000, 20000);
  const timedClient = new MongoClient(RS_URI, { monitorCommands: true, serverSelectionTimeoutMS: 8000 });
  try {
    await timedClient.connect();
    const col = timedClient.db("poc").collection("correspondence");
    const total = await col.estimatedDocumentCount();
    if (mode === "read" && total === 0) return res.status(400).json({ error: "Seed data first" });
    const samples = mode === "read" ? await col.aggregate([{ $sample: { size: 1000 } }]).toArray() : [];
    const queryEvidence = mode === "read"
      ? {
          type: "indexed point read",
          accessPattern: readPattern === "hot" ? "same fileNo on every read" : `random fileNo from ${samples.length} sampled documents`,
          ...await explainFileNoLookup(col, samples[0].fileNo),
        }
      : {
          type: "insert with majority write concern",
          query: 'db.correspondence.insertOne({ fileNo: "LAT/<timestamp>/<sequence>", ... }, { writeConcern: { w: "majority" } })',
          indexUsed: "not applicable to inserts; MongoDB maintains applicable indexes",
          explain: "IXSCAN explain metrics do not apply to write operations",
              cleanup: { query: 'db.correspondence.deleteMany({ fileNo: { $in: <this run\'s fileNos> }, probe: true })', indexUsed: "fileNo_1", runsAfterTimedOperations: true },
        };
    const durations = [];
    const commandDurations = [];
    const poolCheckoutDurations = [];
            const probeFileNos = [];
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedCommands = new Map();
    timedClient.on("commandStarted", event => {
      const command = event.command;
      const isTimed = mode === "read"
        ? event.commandName === "find" && command.find === "correspondence"
        : event.commandName === "insert" && command.insert === "correspondence"
          && command.documents?.some(doc => doc.fileNo?.startsWith(`LAT/${runId}/`));
      if (isTimed) startedCommands.set(event.requestId, event.commandName);
    });
    timedClient.on("commandSucceeded", event => {
      if (startedCommands.delete(event.requestId)) commandDurations.push(event.duration);
    });
    timedClient.on("connectionCheckedOut", event => poolCheckoutDurations.push(event.durationMS));
    for (let i = 0; i < ops; i++) {
      const t = process.hrtime.bigint();
      if (mode === "read") {
        const fileNo = readPattern === "hot" ? samples[0].fileNo : rand(samples).fileNo;
        await col.findOne({ fileNo });
      } else {
        const fileNo = `LAT/${runId}/${i}`;
        probeFileNos.push(fileNo);
        await col.insertOne(
          { fileNo, subject: "latency probe", createdAt: new Date(), probe: true },
          { writeConcern: { w: "majority" } }
        );
      }
      durations.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    if (mode === "write") await col.deleteMany({ fileNo: { $in: probeFileNos }, probe: true });
    const operationStats = stats(durations);
    res.json({
      mode,
      readPattern: mode === "read" ? readPattern : null,
      target: "P99 < 10ms (RFP Appendix D 3.2)",
      queryEvidence,
      timingBreakdown: {
        operationClientRoundTrip: operationStats,
        mongoCommandRoundTrip: commandDurations.length ? stats(commandDurations) : null,
        connectionPoolCheckout: poolCheckoutDurations.length ? stats(poolCheckoutDurations) : null,
        clientAndPoolOutsideCommandAvgMs: mean(durations) == null || mean(commandDurations) == null
          ? null : +(mean(durations) - mean(commandDurations)).toFixed(3),
        databaseExecutionExplain: mode === "read" ? {
          executionTimeMillis: queryEvidence.executionTimeMillis,
          note: "representative explain() measurement only; not the per-operation or p99 server time",
        } : { note: "not available for writes; writeConcern timing is included in command and operation round-trips" },
        note: "MongoDB command round-trip includes server processing plus network. Pool checkout is measured separately; network-only time is not isolated by driver command monitoring.",
      },
      ...operationStats,
      pass: operationStats.p99Ms < 10,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await timedClient.close().catch(() => {});
  }
});

// ---------- Write concern comparison w:1 vs w:majority ----------
app.post("/api/writeconcern", async (req, res) => {
  const ops = Math.min(Number(req.body?.ops) || 500, 5000);
  const col = poc().collection("correspondence");
  try {
    const probeFileNos = [];
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const run = async (wc) => {
      const d = [];
      for (let i = 0; i < ops; i++) {
        const t = process.hrtime.bigint();
        const fileNo = `WC/${runId}/${wc}/${i}`;
        probeFileNos.push(fileNo);
        await col.insertOne({ fileNo, probe: true, createdAt: new Date() }, { writeConcern: { w: wc } });
        d.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      return stats(d);
    };
    const w1 = await run(1);
    const wMaj = await run("majority");
    await col.deleteMany({ fileNo: { $in: probeFileNos }, probe: true });
    res.json({
      "w:1 (primary ack only)": w1,
      "w:majority (durable, zero-data-loss)": wMaj,
      queryEvidence: {
        operation: 'db.correspondence.insertOne({ fileNo: "WC/<writeConcern>/<sequence>", probe: true }, { writeConcern: <w:1|w:majority> })',
        indexUsed: "IXSCAN is not applicable to inserts; MongoDB updates applicable indexes",
        explain: "writeConcern timings are measured per insert; explain executionStats is for read query plans",
        cleanup: { query: 'db.correspondence.deleteMany({ fileNo: { $in: <this run\'s fileNos> }, probe: true })', indexUsed: "fileNo_1", runsAfterTimedOperations: true },
      },
      note: "w:majority cost is the durability premium — this is what guarantees RPO=0 on node failure",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Read from a specific region (tag-based read preference) ----------
app.post("/api/readpref", async (req, res) => {
  const region = ["DC1", "DC2", "DR"].includes(req.body?.region) ? req.body.region : "DR";
  let served = null;
  const c = new MongoClient(RS_URI, { monitorCommands: true, serverSelectionTimeoutMS: 8000 });
  c.on("commandStarted", (ev) => { if (ev.commandName === "find") served = ev.address; });
  try {
    await c.connect();
    const t = process.hrtime.bigint();
    const doc = await c.db("poc").collection("correspondence").findOne(
      {},
      // empty tag set fallback so Atlas (different region tag values) degrades to nearest
      { readPreference: new ReadPreference("nearest", [{ region }, {}]) }
    );
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const node = NODES.find(n => n.host === served);
    res.json({
      requestedRegion: region,
      servedBy: served,
      servedByNode: node ? `${node.name} (${node.region})` : served,
      latencyMs: +ms.toFixed(2),
      sampleDoc: doc ? { fileNo: doc.fileNo, subject: doc.subject } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await c.close().catch(() => {});
  }
});

// ---------- Zero data loss during failover ----------
app.post("/api/zeroloss", async (req, res) => {
  const seconds = Math.min(Number(req.body?.seconds) || 30, 120);
  const col = poc().collection("zeroloss");
  try {
    await col.deleteMany({});
    const end = Date.now() + seconds * 1000;
    let seq = 0, acked = 0, errors = 0, maxStallMs = 0, lastAck = Date.now();
    while (Date.now() < end) {
      seq++;
      try {
        await col.insertOne({ seq, ts: new Date() }, { writeConcern: { w: "majority" } });
        acked++;
        const now = Date.now();
        maxStallMs = Math.max(maxStallMs, now - lastAck);
        lastAck = now;
      } catch { errors++; }
    }
    const found = await col.countDocuments();
    const [gapCheck] = await col.aggregate([
      { $group: { _id: null, count: { $sum: 1 }, maxSeq: { $max: "$seq" } } },
    ]).toArray();
    res.json({
      durationSec: seconds,
      attempted: seq,
      acknowledged: acked,
      transientErrors: errors,
      docsFoundAfter: found,
      ackedEqualsFound: acked === found,
      maxWriteStallMs: maxStallMs,
      verdict: acked === found
        ? `ZERO DATA LOSS: every acknowledged write survived. Longest stall (election window): ${(maxStallMs / 1000).toFixed(1)}s`
        : "MISMATCH — investigate",
      hint: "Run this, then stop the PRIMARY node mid-test to watch retryable writes + election ride through the failure.",
      gapCheck,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Node control ----------
app.post("/api/node/:name/:action", async (req, res) => {
  const { name, action } = req.params;

  if (K8S) {
    if (!/^eoffice-rs-\d+$/.test(name)) return res.status(400).json({ error: "bad pod name" });
    try {
      if (action === "stop") {
        const { stdout } = await runKubectl(["-n", MONGO_NS, "delete", "pod", name, "--wait=false"]);
        return res.json({ node: name, action, result: stdout.trim(), note: "StatefulSet recreates the pod automatically; an election runs if this was the PRIMARY" });
      }
      if (action === "start") {
        const { stdout } = await runKubectl(["-n", MONGO_NS, "get", "pod", name, "-o", "jsonpath={.status.phase}"]);
        return res.json({ node: name, action, phase: stdout.trim(), note: "Pods are managed by the StatefulSet — they restart on their own" });
      }
      if (action === "stepdown") {
        await client.db("admin").command({ replSetStepDown: 60, force: true }).catch(() => {});
        return res.json({ node: name, action, note: "Primary stepped down — watch the new PRIMARY appear" });
      }
      return res.status(400).json({ error: "bad action" });
    } catch (e) {
      return res.status(500).json({ error: e.stderr || e.message });
    }
  }

  if (ATLAS) return res.status(400).json({ error: "Atlas mode: use Test Failover instead (Atlas manages the nodes)" });
  const node = NODES.find(n => n.name === name);
  if (!node || !["stop", "start"].includes(action)) return res.status(400).json({ error: "bad node/action" });
  exec(`docker ${action} ${node.container}`, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ node: node.name, region: node.region, action, result: stdout.trim() });
  });
});

// Simulate a whole-region outage (local mode only)
app.post("/api/region/:region/:action", (req, res) => {
  if (ATLAS) return res.status(400).json({ error: "Atlas mode: node lifecycle is managed by Atlas" });
  const { region, action } = req.params;
  const targets = NODES.filter(n => n.region === region);
  if (!targets.length || !["stop", "start"].includes(action)) return res.status(400).json({ error: "bad region/action" });
  exec(`docker ${action} ${targets.map(t => t.container).join(" ")}`, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ region, action, nodes: targets.map(t => t.name), result: stdout.trim() });
  });
});

// ---------- Atlas Test Failover (Admin API, digest auth via curl) ----------
app.post("/api/atlas/failover", (_req, res) => {
  const { ATLAS_PUBLIC_KEY: pub, ATLAS_PRIVATE_KEY: priv, ATLAS_GROUP_ID: group, ATLAS_CLUSTER: cluster } = process.env;
  if (!pub || !priv || !group || !cluster) return res.status(400).json({ error: "Set ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY, ATLAS_GROUP_ID, ATLAS_CLUSTER" });
  const url = `https://cloud.mongodb.com/api/atlas/v2/groups/${group}/clusters/${cluster}/restartPrimaries`;
  exec(`curl -s -w '\\n%{http_code}' --digest -u "${pub}:${priv}" -X POST -H "Accept: application/vnd.atlas.2023-01-01+json" "${url}"`, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const lines = stdout.trim().split("\n");
    const code = lines.pop();
    res.json({ httpStatus: code, response: lines.join("\n") || "(empty)", note: "Atlas is restarting the primary — run the Zero Data Loss test now and watch the election" });
  });
});

// ---------- Immutability (append-only audit role) ----------
app.post("/api/immutability", async (_req, res) => {
  const c = new MongoClient(AUDIT_URI, { serverSelectionTimeoutMS: 8000 });
  const out = {};
  try {
    await c.connect();
    const audit = c.db("poc").collection("audit_log");
    const ins = await audit.insertOne({ event: "IMMUTABILITY_TEST", user: "audituser", ts: new Date() });
    out.insert = { allowed: true, id: ins.insertedId };
    try {
      await audit.updateOne({ _id: ins.insertedId }, { $set: { tampered: true } });
      out.update = { allowed: true, WARNING: "should have been denied!" };
    } catch (e) { out.update = { allowed: false, deniedWith: e.codeName || e.message }; }
    try {
      await audit.deleteOne({ _id: ins.insertedId });
      out.delete = { allowed: true, WARNING: "should have been denied!" };
    } catch (e) { out.delete = { allowed: false, deniedWith: e.codeName || e.message }; }
    out.verdict = (!out.update.allowed && !out.delete.allowed)
      ? "IMMUTABLE: audit records can be written and read, never modified or deleted (RBAC-enforced)"
      : "NOT immutable — check role config";
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await c.close().catch(() => {});
  }
});

// ---------- Audit trail via change streams (old vs new values) ----------
app.post("/api/audit-change", async (_req, res) => {
  const col = poc().collection("correspondence");
  try {
    const doc = await col.findOne({ probe: { $ne: true } });
    if (!doc) return res.status(400).json({ error: "Seed data first" });
    const stream = col.watch([{ $match: { "documentKey._id": doc._id } }], {
      fullDocument: "updateLookup",
      fullDocumentBeforeChange: "whenAvailable",
    });
    const eventPromise = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("change stream timeout")), 8000);
      stream.on("change", (ev) => { clearTimeout(to); resolve(ev); });
      stream.on("error", reject);
    });
    const newStatus = doc.status === "CLOSED" ? "REOPENED" : "CLOSED";
    await col.updateOne({ _id: doc._id }, { $set: { status: newStatus, lastActionBy: "demo-user", lastActionAt: new Date() } });
    const ev = await eventPromise;
    await stream.close();
    const auditEntry = {
      event: ev.operationType,
      fileNo: doc.fileNo,
      changedFields: ev.updateDescription?.updatedFields,
      oldValues: ev.fullDocumentBeforeChange ? { status: ev.fullDocumentBeforeChange.status } : null,
      newValues: ev.fullDocument ? { status: ev.fullDocument.status } : null,
      clusterTime: ev.clusterTime,
      capturedBy: "change stream (pre/post images)",
    };
    await poc().collection("audit_log").insertOne({ ...auditEntry, ts: new Date() });
    res.json({ note: "Old + new values captured automatically and appended to immutable audit_log", auditEntry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Full-text search ----------
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "pass ?q=" });
  const col = poc().collection("correspondence");
  try {
    const t = process.hrtime.bigint();
    const results = await col.find(
      { $text: { $search: q } },
      { projection: { score: { $meta: "textScore" }, fileNo: 1, subject: 1, directorate: 1, status: 1 } }
    ).sort({ score: { $meta: "textScore" } }).limit(10).toArray();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    res.json({ query: q, latencyMs: +ms.toFixed(2), hits: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Indexes: definitions, sizes, usage, and query plan proof ----------
app.get("/api/indexes", async (_req, res) => {
  try {
    const db = poc();
    const collections = ["correspondence", "audit_log", "zeroloss"];
    const out = {};
    for (const name of collections) {
      const col = db.collection(name);
      const [indexes, idxStats, collStats] = await Promise.all([
        col.listIndexes().toArray().catch(() => []),
        col.aggregate([{ $indexStats: {} }]).toArray().catch(() => []),
        db.command({ collStats: name }).catch(() => null),
      ]);
      const usage = Object.fromEntries(idxStats.map(s => [s.name, s.accesses?.ops ?? 0]));
      out[name] = {
        docCount: collStats?.count ?? null,
        totalIndexSizeMB: collStats ? +(collStats.totalIndexSize / 1048576).toFixed(2) : null,
        indexes: indexes.map(ix => ({
          name: ix.name,
          keys: ix.key,
          type: ix.textIndexVersion ? "text" : ix.unique ? "unique" : "btree",
          sizeMB: collStats?.indexSizes?.[ix.name] != null ? +(collStats.indexSizes[ix.name] / 1048576).toFixed(2) : null,
          timesUsed: usage[ix.name] ?? 0,
        })),
      };
    }
    res.json({
      queryEvidence: {
        operations: [
          "db.correspondence.listIndexes()",
          "db.correspondence.aggregate([{ $indexStats: {} }])",
          "db.runCommand({ collStats: <collection> })",
        ],
        indexUsed: "metadata/statistics commands; no correspondence find query is executed",
        explain: "not applicable to index metadata commands",
      },
      collections: out,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/explain", async (_req, res) => {
  try {
    const col = poc().collection("correspondence");
    const total = await col.estimatedDocumentCount();
    if (!total) return res.status(400).json({ error: "Seed data first" });
    const sampleDoc = await col.aggregate([{ $sample: { size: 1 } }]).next();
    const sampleFileNo = sampleDoc.fileNo;
    const exp = await col.find({ fileNo: sampleFileNo }).explain("executionStats");
    const winning = exp.queryPlanner?.winningPlan;
    const es = exp.executionStats;
    const stage = winning?.stage === "FETCH" ? winning.inputStage : winning;
    res.json({
      query: { fileNo: sampleFileNo },
      winningPlanStage: `${winning?.stage}${stage?.stage ? " <- " + stage.stage : ""}`,
      indexUsed: stage?.indexName || null,
      keyPattern: stage?.keyPattern || null,
      verdict: (stage?.stage === "IXSCAN")
        ? `IXSCAN: examined ${es.totalKeysExamined} key(s) and ${es.totalDocsExamined} doc(s) out of ${total.toLocaleString()} to return ${es.nReturned} — this selectivity is WHY P99 < 10ms`
        : "WARNING: COLLSCAN — query is not using an index",
      executionTimeMs: es.executionTimeMillis,
      totalKeysExamined: es.totalKeysExamined,
      totalDocsExamined: es.totalDocsExamined,
      nReturned: es.nReturned,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pod IPs let the generator reach mongod directly instead of through the kubectl port-forward tunnel.
async function loadTargets(run, rsStatus) {
  if (!K8S) { run.targets = ["replica-set URI"]; return [RS_URI]; }
  const { stdout } = await runKubectl(["-n", MONGO_NS, "get", "pods", "-o", "json"]);
  const ipByPod = Object.fromEntries(JSON.parse(stdout).items.map(p => [p.metadata.name, p.status.podIP]));
  const members = rsStatus.members.map(m => ({ pod: m.name.split(".")[0], role: m.stateStr })).filter(m => ipByPod[m.pod]);
  let chosen = run.readPreference === "secondaryPreferred" ? members.filter(m => m.role === "SECONDARY") : members.filter(m => m.role === "PRIMARY");
  if (!chosen.length) chosen = members;
  run.targets = chosen.map(m => `${m.pod} (${m.role}) ${ipByPod[m.pod]}`);
  return chosen.map(m => directMemberUri(RS_URI, `${ipByPod[m.pod]}:27017`));
}

function runWorkers(run, fileNos, uris) {
  const n = Math.max(1, Math.min(Math.ceil(run.targetTps / 1000), 8));
  run.workers = n;
  const states = Array.from({ length: n }, () => ({ s: null, samples: [] }));
  const merge = () => {
    const live = states.filter(x => x.s);
    const sum = (k) => live.reduce((a, x) => a + x.s[k], 0);
    run.offered = sum("offered"); run.started = sum("started"); run.completed = sum("completed");
    run.errors = sum("errors"); run.droppedForUserCap = sum("dropped"); run.inFlight = sum("inFlight");
    run.peakInFlight = Math.max(run.peakInFlight, run.inFlight);
    run.clientSamples = live.flatMap(x => x.samples);
  };
  return new Promise((resolve, reject) => {
    let remaining = n;
    const children = [];
    const finish = (err) => {
      children.forEach(c => c.kill());
      err ? reject(err) : resolve();
    };
    const guard = setTimeout(() => finish(new Error("read-load workers timed out")), (run.durationSec + 60) * 1000);
    for (let i = 0; i < n; i++) {
      const child = fork(path.join(__dirname, "readload-worker.js"));
      children.push(child);
      child.on("message", (m) => {
        if (m.type === "error") { clearTimeout(guard); return finish(new Error(m.message)); }
        states[i] = { s: m.s, samples: m.samples };
        merge();
        if (m.type === "done" && --remaining === 0) { clearTimeout(guard); finish(); }
      });
      child.on("exit", (code) => { if (code && remaining > 0) { clearTimeout(guard); finish(new Error(`worker exited with code ${code}`)); } });
      child.send({
        type: "start", uris, readPreference: run.readPreference, tps: run.targetTps / n,
        maxUsers: Math.ceil(run.maxUsers / n), durationSec: run.durationSec, readPattern: run.readPattern,
        fileNos, profileAppName: run.profileAppName, sampleEvery: PROFILE_SAMPLE_EVERY, id: run.id,
      });
    }
  });
}

async function executeProfiledReadLoad(run) {
  const profileStates = [];
  let workloadClient;
  try {
    workloadClient = new MongoClient(RS_URI, {
      appName: `eoffice-readload-setup-${run.id}`,
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
    });
    await workloadClient.connect();
    const col = workloadClient.db("poc").collection("correspondence");
    const samples = await col.aggregate([{ $sample: { size: 1000 } }]).toArray();
    if (!samples.length) throw new Error("Seed data first");
    run.exampleFileNo = samples[0].fileNo;
    run.query = `db.correspondence.findOne({ fileNo: ${JSON.stringify(run.exampleFileNo)} })`;

    const status = await workloadClient.db("admin").command({ replSetGetStatus: 1 });
    run.members = [];
    for (const member of status.members) {
      const directClient = new MongoClient(directMemberUri(RS_URI, member.name), { serverSelectionTimeoutMS: 5000 });
      await directClient.connect();
      run.members.push({ name: member.name, client: directClient });
    }

    for (const member of run.members) {
      const database = member.client.db("poc");
      const previous = await database.command({ profile: -1 });
      if (previous.was !== 0) throw new Error(`Profiler is already enabled on ${member.name}; refusing to override it`);
      if (previous.filter) throw new Error(`A custom profiler filter exists on ${member.name}; refusing to replace it`);
      profileStates.push({ database, previous, member: member.name });
    }

    run.startedAt = new Date();
    run.startedAtMono = performance.now();
    for (const state of profileStates) {
      await state.database.command({ profile: 1, filter: { appName: run.profileAppName } });
      state.enabled = true;
    }

    run.state = "running";
    const targets = await loadTargets(run, status);
    await runWorkers(run, samples.map(s => s.fileNo), targets);
    await captureProfilerSamples(run);
  } catch (error) {
    run.error = error.message;
    run.state = "failed";
  } finally {
    for (const state of profileStates.reverse()) {
      if (!state.enabled) continue;
      try {
        await state.database.command({
          profile: state.previous.was,
          slowms: state.previous.slowms,
          sampleRate: state.previous.sampleRate,
          filter: state.previous.filter || "unset",
        });
      } catch (error) {
        run.restoreErrors.push(`${state.member}: ${error.message}`);
      }
    }
    for (const member of run.members || []) await member.client.close().catch(() => {});
    await workloadClient?.close().catch(() => {});
    if (activeProfiledReadRun === run.id) activeProfiledReadRun = null;
    if (run.state !== "failed") run.state = "complete";
    run.finishedAt = new Date();
  }
}

app.post("/api/read-load", (req, res) => {
  if (activeProfiledReadRun) return res.status(409).json({ error: "A profiled read-load test is already running", runId: activeProfiledReadRun });
  const durationSec = Number(req.body?.durationSec);
  const targetTps = Number(req.body?.targetTps);
  const maxUsers = Number(req.body?.maxUsers);
  const readPattern = req.body?.readPattern === "hot" ? "hot" : "random";
  const readPreference = req.body?.readPreference === "secondaryPreferred" ? "secondaryPreferred" : "primary";
  if (![10, 20, 30, 120].includes(durationSec)) return res.status(400).json({ error: "durationSec must be 10, 20, 30, or 120" });
  if (!Number.isInteger(targetTps) || targetTps < 1 || targetTps > 20000) return res.status(400).json({ error: "targetTps must be an integer from 1 to 20000" });
  if (!Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > 10000) return res.status(400).json({ error: "maxUsers must be an integer from 1 to 10000" });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    id, profileAppName: `eoffice-readload-sample-${id}`, state: "preparing", durationSec, targetTps, maxUsers, readPattern, readPreference,
    offered: 0, started: 0, completed: 0, errors: 0, droppedForUserCap: 0, inFlight: 0, peakInFlight: 0, clientSeen: 0,
    clientSamples: [], serverElapsedSamples: [], serverWorkingSamples: [], profileIds: new Set(), profiledOperations: 0,
    keysExamined: 0, docsExamined: 0, planSummaries: {}, restoreErrors: [], members: [],
  };
  readLoadRuns.set(id, run);
  activeProfiledReadRun = id;
  void executeProfiledReadLoad(run);
  res.status(202).json(readLoadSnapshot(run));
});

app.get("/api/read-load/:runId", async (req, res) => {
  const run = readLoadRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: "read-load run not found" });
  if (run.state === "running" && !run.captureBusy) {
    run.captureBusy = true;
    try { await captureProfilerSamples(run); }
    catch (error) { run.profilerCaptureError = error.message; }
    finally { run.captureBusy = false; }
  }
  res.json({ ...readLoadSnapshot(run), error: run.error || null, profilerCaptureError: run.profilerCaptureError || null, restoreErrors: run.restoreErrors });
});

// ---------- Legacy mixed read/write concurrency & TPS ----------
app.post("/api/concurrency", async (req, res) => {
  const mode = req.body?.mode === "virtual" ? "virtual" : "stress";
  const seconds = Math.min(Number(req.body?.seconds) || 20, 120);
  const readPattern = req.body?.readPattern === "hot" ? "hot" : "random";
  const readPreference = req.body?.readPreference === "secondaryPreferred" ? "secondaryPreferred" : "primary";
  const requestedReadRatio = Number(req.body?.readRatio);
  const readRatio = Number.isFinite(requestedReadRatio) ? Math.min(Math.max(requestedReadRatio, 0), 1) : 0.8;
  const workers = mode === "stress" ? Math.min(Number(req.body?.workers) || 200, 2000) : Math.min(Number(req.body?.users) || 10000, 20000);
  const thinkMs = mode === "virtual" ? (Number(req.body?.thinkTimeSec) || 15) * 1000 : 0;
  const maxPoolSize = Math.min(mode === "stress" ? workers : 500, 1000);
  const maxConnecting = Math.min(Math.max(Math.ceil(maxPoolSize / 10), 2), 50);

  const poolClient = new MongoClient(RS_URI, { maxPoolSize, maxConnecting, monitorCommands: true, serverSelectionTimeoutMS: 8000 });
  try {
    await poolClient.connect();
    const col = poolClient.db("poc").collection("correspondence");
    const total = await col.estimatedDocumentCount();
    if (!total) return res.status(400).json({ error: "Seed data first" });
    const samples = await col.aggregate([{ $sample: { size: 1000 } }]).toArray();
    const readEvidence = readRatio > 0
      ? {
          type: "indexed point read",
          ...await explainFileNoLookup(col, samples[0].fileNo),
          samplePoolSize: samples.length,
          accessPattern: readPattern === "hot" ? "all reads use the same sampled fileNo" : "each read randomly selects a fileNo from this sample pool",
          readPreference,
        }
      : { type: "read disabled", query: null, indexUsed: "not applicable" };

    const latencies = [];
    const probeFileNos = [];
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const readFileNos = new Set();
    const readQuerySamples = [];
    const writeQuerySamples = [];
    const readCommandDurations = [];
    const writeCommandDurations = [];
    const poolCheckoutDurations = [];
    const startedCommands = new Map();
    let errors = 0, inFlight = 0, peakInFlight = 0, opsDone = 0, readOps = 0, writeOps = 0;
    poolClient.on("commandStarted", event => {
      const command = event.command;
      if (event.commandName === "find" && command.find === "correspondence") {
        startedCommands.set(event.requestId, "read");
      } else if (event.commandName === "insert" && command.insert === "correspondence"
        && command.documents?.some(doc => doc.fileNo?.startsWith(`CONC/${runId}/`))) {
        startedCommands.set(event.requestId, "write");
      }
    });
    poolClient.on("commandSucceeded", event => {
      const kind = startedCommands.get(event.requestId);
      if (!kind) return;
      startedCommands.delete(event.requestId);
      (kind === "read" ? readCommandDurations : writeCommandDurations).push(event.duration);
    });
    poolClient.on("connectionCheckedOut", event => poolCheckoutDurations.push(event.durationMS));
    const deadline = Date.now() + seconds * 1000;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const oneOp = async () => {
      inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
      const t = process.hrtime.bigint();
      try {
        if (Math.random() < readRatio) {
          const fileNo = readPattern === "hot" ? samples[0].fileNo : rand(samples).fileNo;
          await col.findOne({ fileNo }, { readPreference: new ReadPreference(readPreference) });
          readOps++;
          readFileNos.add(fileNo);
          const readQuery = `db.correspondence.findOne({ fileNo: ${JSON.stringify(fileNo)} })`;
          if (!readQuerySamples.includes(readQuery) && readQuerySamples.length < 5) readQuerySamples.push(readQuery);
        } else {
          const fileNo = `CONC/${runId}/${Math.random()}`;
          probeFileNos.push(fileNo);
          await col.insertOne({ fileNo, probe: true, createdAt: new Date() }, { writeConcern: { w: "majority" } });
          writeOps++;
          if (writeQuerySamples.length < 5) writeQuerySamples.push(`db.correspondence.insertOne({ fileNo: ${JSON.stringify(fileNo)}, probe: true }, { writeConcern: { w: "majority" } })`);
        }
        latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
        opsDone++;
      } catch { errors++; }
      finally { inFlight--; }
    };

    const workerLoop = async () => {
      // virtual users start staggered so think-time ticks don't align
      if (thinkMs) await sleep(Math.random() * thinkMs);
      while (Date.now() < deadline) {
        await oneOp();
        if (thinkMs) await sleep(thinkMs * (0.5 + Math.random()));
      }
    };

    const t0 = Date.now();
    await Promise.all(Array.from({ length: workers }, workerLoop));
    const wallSec = (Date.now() - t0) / 1000;

    const ss = await poolClient.db("admin").command({ serverStatus: 1 });
    if (probeFileNos.length) await col.deleteMany({ fileNo: { $in: probeFileNos }, probe: true });
    if (readRatio > 0) {
      readEvidence.completedReads = readOps;
      readEvidence.distinctFileNosUsed = readFileNos.size;
      readEvidence.actualQuerySamples = readQuerySamples;
    }

    res.json({
      mode: mode === "virtual" ? `${workers} virtual users @ ~${thinkMs / 1000}s think time` : `${workers} parallel workers, zero think time`,
      readRatio,
      readPattern: readRatio > 0 ? readPattern : null,
      readPreference: readRatio > 0 ? readPreference : null,
      durationSec: +wallSec.toFixed(1),
      opsCompleted: opsDone,
      throughputTPS: +(opsDone / wallSec).toFixed(0),
      peakInFlightOps: peakInFlight,
      errors,
      queryEvidence: {
        read: readEvidence,
        write: readRatio < 1 ? {
          type: "insert with majority write concern",
          query: 'db.correspondence.insertOne({ fileNo: "CONC/<timestamp>/<random>", probe: true }, { writeConcern: { w: "majority" } })',
          completedWrites: writeOps,
          actualQuerySamples: writeQuerySamples,
          indexUsed: "not applicable to inserts; MongoDB maintains applicable indexes",
          explain: "IXSCAN explain metrics do not apply to write operations",
          cleanup: { query: 'db.correspondence.deleteMany({ fileNo: { $in: <this run\'s fileNos> }, probe: true })', indexUsed: "fileNo_1", runsAfterTimedOperations: true },
        } : null,
      },
      latencyUnderLoad: latencies.length ? stats(latencies) : null,
      timingBreakdown: {
        operationClientRoundTrip: latencies.length ? stats(latencies) : null,
        readMongoCommandRoundTrip: readCommandDurations.length ? stats(readCommandDurations) : null,
        writeMongoCommandRoundTrip: writeCommandDurations.length ? stats(writeCommandDurations) : null,
        connectionPoolCheckout: poolCheckoutDurations.length ? stats(poolCheckoutDurations) : null,
        clientAndPoolOutsideCommandAvgMs: mean(latencies) == null || readCommandDurations.length + writeCommandDurations.length === 0
          ? null : +(mean(latencies) - mean([...readCommandDurations, ...writeCommandDurations])).toFixed(3),
        databaseExecutionExplain: readRatio > 0 ? {
          executionTimeMillis: readEvidence.executionTimeMillis,
          note: "representative explain() measurement only; not the per-operation or p99 server time",
        } : { note: "no read query in this workload; writeConcern timing is included in command round-trip" },
        note: "MongoDB command round-trip includes server processing plus network. Pool checkout is measured separately; network-only time is not isolated by driver command monitoring.",
      },
      connectionPool: { maxPoolSize, maxConnecting },
      serverConnections: { current: ss.connections.current, available: ss.connections.available },
      rfpTargets: { "TPS > 5000": opsDone / wallSec > 5000, "P99 < 10ms": latencies.length ? stats(latencies).p99Ms < 10 : null },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await poolClient.close().catch(() => {});
  }
});

// ---------- Index comparison: single vs compound vs no index ----------
app.post("/api/index-compare", async (_req, res) => {
  const col = poc().collection("correspondence");
  try {
    const total = await col.estimatedDocumentCount();
    if (!total) return res.status(400).json({ error: "Seed data first" });

    const timeIt = async (n, fn) => {
      const d = [];
      for (let i = 0; i < n; i++) {
        const t = process.hrtime.bigint();
        await fn();
        d.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      return stats(d);
    };
    const planOf = async (cursorFactory) => {
      const exp = await cursorFactory().explain("executionStats");
      const w = exp.queryPlanner?.winningPlan;
      let stage = w; while (stage?.inputStage) stage = stage.inputStage;
      return {
        plan: stage?.stage || w?.stage,
        indexUsed: stage?.indexName || null,
        executionTimeMillis: exp.executionStats.executionTimeMillis,
        keysExamined: exp.executionStats.totalKeysExamined,
        docsExamined: exp.executionStats.totalDocsExamined,
        nReturned: exp.executionStats.nReturned,
      };
    };

    // sample real docs so every lookup is a guaranteed hit
    const samples = await col.aggregate([{ $sample: { size: 300 } }]).toArray();
    const randFileNo = () => rand(samples).fileNo;
    const refDoc = rand(samples);
    const refTarget = refDoc.body.match(/Ref \d+\./)?.[0] || refDoc.fileNo;

    // 1. single-field index: exact point lookup
    const single = {
      scenario: "Point lookup via fileNo_1 (single-field index)",
      query: '{ fileNo: "<existing fileNo>" }',
      ...(await planOf(() => col.find({ fileNo: randFileNo() }))),
      ...(await timeIt(300, () => col.findOne({ fileNo: randFileNo() }))),
    };

    // 2. compound index: filter + sort fully covered by directorate_1_status_1_createdAt_-1
    const compound = {
      scenario: "Filter + sort via directorate_1_status_1_createdAt_-1 (compound index, sort for free)",
      query: '{ directorate: "Ops", status: "OPEN" } sort { createdAt: -1 } limit 10',
      ...(await planOf(() => col.find({ directorate: "Ops", status: "OPEN" }).sort({ createdAt: -1 }).limit(10))),
      ...(await timeIt(300, () => col.find({ directorate: rand(DIRS), status: "OPEN" }).sort({ createdAt: -1 }).limit(10).toArray())),
    };

    // 3. no index: same "find one specific doc" but via unindexed body regex => COLLSCAN
    const none = {
      scenario: "Same single-doc lookup via UNINDEXED field (body regex) — full collection scan",
      query: `{ body: /${refTarget}/ }`,
      ...(await planOf(() => col.find({ body: new RegExp(refTarget) }))),
      ...(await timeIt(10, () => col.findOne({ body: new RegExp(refTarget) }))),
    };

    const slowdown = single.avgMs > 0 ? +(none.avgMs / single.avgMs).toFixed(0) : null;
    res.json({
      corpusSize: total,
      comparison: [single, compound, none],
      verdict: `COLLSCAN is ~${slowdown}x slower than the indexed point lookup on ${total.toLocaleString()} docs — and the gap grows linearly with data size. Index selectivity is the entire P99 story.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Server-side opLatencies per node ----------
app.get("/api/oplatencies", async (_req, res) => {
  const out = [];
  // discover live hosts (works for local docker, Kubernetes and Atlas)
  let hosts = NODES.map(n => ({ host: n.host, name: n.name, region: n.region }));
  if (ATLAS || K8S) {
    try {
      const st = await client.db("admin").command({ replSetGetStatus: 1 });
      hosts = st.members.map(m => ({ host: m.name, name: m.name.split(".")[0], region: ATLAS ? "atlas" : "k8s" }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  const [, creds] = RS_URI.match(/\/\/([^@]+)@/) || [];
  for (const n of hosts) {
    const uri = ATLAS
      ? `mongodb://${creds}@${n.host}/?authSource=admin&tls=true&directConnection=true`
      : `mongodb://${ADMIN_USER}:${ADMIN_PASS}@${n.host}/?authSource=admin&directConnection=true`;
    const c = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    try {
      await c.connect();
      const ss = await c.db("admin").command({ serverStatus: 1 });
      const fmt = (o) => o.ops > 0 ? +(o.latency / o.ops / 1000).toFixed(3) : 0;
      out.push({
        node: n.name, region: n.region, up: true,
        avgReadMs: fmt(ss.opLatencies.reads),
        avgWriteMs: fmt(ss.opLatencies.writes),
        totalReads: ss.opLatencies.reads.ops,
        totalWrites: ss.opLatencies.writes.ops,
      });
    } catch {
      out.push({ node: n.name, region: n.region, up: false });
    } finally {
      await c.close().catch(() => {});
    }
  }
  res.json({
    queryEvidence: {
      operation: "db.adminCommand({ serverStatus: 1 }) on each replica-set member",
      indexUsed: "not applicable; serverStatus reports server-wide counters, not a collection query",
      explain: "not applicable; opLatencies is cumulative mongod timing, not a per-query plan",
    },
    note: "Server-side cumulative op latency per node (DB-layer evidence, independent of client)",
    nodes: out,
  });
});

// ---------- ERP data endpoints ----------
let priorityCache = { at: 0, rows: [] };
app.get("/api/overview", async (_req, res) => {
  try {
    const t0 = performance.now();
    const col = poc().collection("correspondence");
    // status/directorate tiles: sum ≈24 pre-aggregated counter docs instead of scanning 1M documents
    let counters = await poc().collection("counters").find({}).toArray();
    if (!counters.length) { await rebuildCounters(); counters = await poc().collection("counters").find({}).toArray(); }
    const sumBy = (key) => Object.entries(counters.reduce((m, c) => ((m[c[key]] = (m[c[key]] || 0) + c.n), m), {}))
      .map(([_id, n]) => ({ _id, n })).sort((a, b) => b.n - a.n);
    if (Date.now() - priorityCache.at > 60000) {
      priorityCache = { at: Date.now(), rows: await col.aggregate([{ $group: { _id: "$priority", n: { $sum: 1 } } }]).toArray() };
    }
    const recent = await col.find({}, { projection: { fileNo: 1, subject: 1, directorate: 1, status: 1, priority: 1, createdAt: 1 } })
      .sort({ createdAt: -1 }).limit(6).toArray();
    const total = await col.estimatedDocumentCount();
    const audits = await poc().collection("audit_log").estimatedDocumentCount();
    res.json({
      total, audits, byStatus: sumBy("status"), byDirectorate: sumBy("directorate"), byPriority: priorityCache.rows, recent,
      timing: { totalMs: +(performance.now() - t0).toFixed(1), counterDocs: counters.length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const countCache = new Map(); // filterKey -> { count, at }  (30s TTL; counts are pagination hints, staleness is fine)
app.get("/api/files", async (req, res) => {
  try {
    const col = poc().collection("correspondence");
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 15;
    const filter = {};
    const search = String(req.query.q || "").trim();
    const exactFileNo = search.includes("/");
    if (req.query.status) filter.status = req.query.status;
    if (req.query.directorate) filter.directorate = req.query.directorate;
    if (search) {
      if (exactFileNo) filter.fileNo = search;
      else filter.$text = { $search: search };
    }
    const cursor = () => col.find(filter).sort(exactFileNo ? { fileNo: 1 } : { createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .project({ fileNo: 1, subject: 1, directorate: 1, status: 1, priority: 1, createdAt: 1 });
    const tFind = process.hrtime.bigint();
    const docs = await cursor().toArray();
    const findMs = +(Number(process.hrtime.bigint() - tFind) / 1e6).toFixed(1);

    const key = JSON.stringify(filter);
    const cached = countCache.get(key);
    let count, countMs, countSource;
    const tCount = process.hrtime.bigint();
    if (exactFileNo) {
      count = await col.countDocuments(filter);
      countSource = "exact file-number lookup";
    } else if (!filter.$text) {
      // O(1): sum ≤24 pre-aggregated counter docs instead of walking the index
      const cq = {};
      if (filter.status) cq.status = filter.status;
      if (filter.directorate) cq.directorate = filter.directorate;
      let rows = await poc().collection("counters").find(cq).toArray();
      if (!rows.length) { await rebuildCounters(); rows = await poc().collection("counters").find(cq).toArray(); }
      count = rows.reduce((a, r) => a + r.n, 0);
      countSource = "pre-aggregated counters (O(1), exact)";
    } else if (cached && Date.now() - cached.at < 30000) {
      count = cached.count; countSource = "cache";
    } else {
      count = await col.countDocuments(filter, { limit: 10000 }); countSource = "index walk (cap 10K)";
      countCache.set(key, { count, at: Date.now() });
    }
    countMs = +(Number(process.hrtime.bigint() - tCount) / 1e6).toFixed(1);
    // cheap planner-only explain so the UI can show which index served the page
    let indexUsed = null, plan = null;
    try {
      const exp = await cursor().explain("queryPlanner");
      let s = exp.queryPlanner?.winningPlan; while (s?.inputStage) s = s.inputStage;
      plan = s?.stage; indexUsed = s?.indexName || null;
    } catch { /* $text explain quirks */ }
    const sort = exactFileNo ? { fileNo: 1 } : { createdAt: -1 };
    res.json({ page, pages: Math.ceil(count / limit), count, findMs, countMs, countSource, plan, indexUsed, query: `db.correspondence.find(${JSON.stringify(filter)}).sort(${JSON.stringify(sort)}).skip(${(page - 1) * limit}).limit(${limit})`, docs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/audit-log", async (_req, res) => {
  try {
    const docs = await poc().collection("audit_log").find().sort({ ts: -1 }).limit(30).toArray();
    res.json({ count: docs.length, docs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
registerAiRoutes(app, { getClient: () => client, runKubectl, ns: MONGO_NS });
registerWorkflowRoutes(app, { getClient: () => client });

// A failed connect leaves the topology permanently closed, so every later request
// would 500 with "Topology is closed" — keep retrying until the replica set is up.
let connected = false;
async function connectWithRetry(delayMs = 5000) {
  try {
    await client.connect();
    connected = true;
    console.log(`Connected to ${RS_URI.replace(/\/\/[^@]*@/, "//***@")}`);
    await poc().collection("correspondence").createIndex({ fileNo: 1 });
    await rebuildCounters().then(n => console.log(`Counters rebuilt (${n} buckets)`)).catch(e => console.error("counter rebuild:", e.message));
    startCounterWatcher();
  } catch (e) {
    console.error(`Connect failed (${e.message}) — retrying in ${delayMs / 1000}s`);
    await client.close().catch(() => {});
    client = new MongoClient(RS_URI, { serverSelectionTimeoutMS: 8000 });
    setTimeout(() => connectWithRetry(Math.min(delayMs * 2, 30000)), delayMs);
  }
}
connectWithRetry();
app.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));
