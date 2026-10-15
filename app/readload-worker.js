// Read-load worker: one OS process = one event loop. The parent forks several so the
// generator is not limited by a single Node thread, and connects each straight to mongod pods.
import { MongoClient, ReadPreference } from "mongodb";

const RESERVOIR = 5000;

process.on("message", async (cfg) => {
  if (cfg.type !== "start") return;
  const { uris, readPreference, tps, maxUsers, durationSec, readPattern, fileNos, profileAppName, sampleEvery, id } = cfg;
  const perTargetPool = Math.max(2, Math.min(Math.ceil(maxUsers / uris.length), 500));
  const traffic = uris.map(uri => new MongoClient(uri, { appName: `eoffice-readload-traffic-${id}`, maxPoolSize: perTargetPool, maxConnecting: 20, serverSelectionTimeoutMS: 8000 }));
  const profiled = uris.map(uri => new MongoClient(uri, { appName: profileAppName, maxPoolSize: 4, serverSelectionTimeoutMS: 8000 }));
  try {
    await Promise.all([...traffic, ...profiled].map(c => c.connect()));
    const cols = traffic.map(c => c.db("poc").collection("correspondence"));
    const pcols = profiled.map(c => c.db("poc").collection("correspondence"));
    const rp = new ReadPreference(readPreference);

    const s = { offered: 0, started: 0, completed: 0, errors: 0, dropped: 0, inFlight: 0, peak: 0 };
    const samples = [];
    let seen = 0, seq = 0, rr = 0;
    const pending = new Set();

    const launch = () => {
      const profile = seq++ % sampleEvery === 0;
      const fileNo = readPattern === "hot" ? fileNos[0] : fileNos[(Math.random() * fileNos.length) | 0];
      const t = rr++ % uris.length;
      const start = performance.now();
      s.inFlight++; s.started++;
      if (s.inFlight > s.peak) s.peak = s.inFlight;
      const p = (profile ? pcols[t] : cols[t]).findOne({ fileNo }, { readPreference: rp })
        .then(() => { s.completed++; }, () => { s.errors++; })
        .finally(() => {
          const d = performance.now() - start;
          seen++;
          if (samples.length < RESERVOIR) samples.push(d);
          else { const j = (Math.random() * seen) | 0; if (j < RESERVOIR) samples[j] = d; }
          s.inFlight--;
          pending.delete(p);
        });
      pending.add(p);
    };

    const report = (final = false) => process.send({ type: final ? "done" : "progress", s: { ...s }, samples: [...samples] });
    const ticker = setInterval(report, 500);

    const intervalMs = 1000 / tps;
    const deadline = performance.now() + durationSec * 1000;
    let next = performance.now();
    while (performance.now() < deadline) {
      const now = performance.now();
      if (now < next) { await new Promise(r => setTimeout(r, Math.min(1, next - now))); continue; }
      const arrivals = Math.min(2000, Math.floor((now - next) / intervalMs) + 1);
      for (let i = 0; i < arrivals; i++) {
        next += intervalMs;
        s.offered++;
        if (s.inFlight >= maxUsers) s.dropped++; else launch();
      }
      // yield so completions are processed; a pure tight loop would starve the event loop
      await new Promise(r => setImmediate(r));
    }
    await Promise.allSettled([...pending]);
    clearInterval(ticker);
    report(true);
  } catch (e) {
    process.send({ type: "error", message: e.message });
  } finally {
    await Promise.allSettled([...traffic, ...profiled].map(c => c.close()));
    process.exit(0);
  }
});
