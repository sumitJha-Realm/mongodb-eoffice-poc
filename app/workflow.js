import { ObjectId } from "mongodb";

const STAGES = ["Section Review", "Directorate Approval", "Final Sanction"];
const TX = { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", wtimeoutMS: 15000 }, readPreference: "primary", maxCommitTimeMS: 15000 };
const names = { files: "wf_files", tasks: "wf_tasks", officers: "wf_officers", dirs: "wf_directorates", meta: "wf_meta" };
const schema = (required, properties) => ({ $jsonSchema: { bsonType: "object", required, properties } });
const string = { bsonType: "string", minLength: 1 };

export function registerWorkflowRoutes(app, { getClient }) {
  const db = () => getClient().db("poc");
  const col = key => db().collection(names[key]);
  let setupRunning = false;
  const route = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
  };
  const fail = (message, status = 409) => Object.assign(new Error(message), { status });
  async function ready() {
    if (!(await col("meta").findOne({ _id: "setup", ready: true }))) throw fail("Prepare the 5,000-file workbench first.");
  }
  async function snapshot(fileId) {
    return {
      file: await col("files").findOne({ _id: fileId }),
      tasks: await col("tasks").find({ fileId }).sort({ stage: 1 }).toArray(),
    };
  }
  async function transition(fileId, version, rollback = false) {
    const session = getClient().startSession();
    try {
      return await session.withTransaction(async () => {
        const file = await col("files").findOne({ _id: fileId }, { session });
        if (!file) throw fail("Workflow not found", 404);
        if (file.version !== version) throw fail("Stale version: another officer has already acted.");
        if (file.status === "COMPLETED") throw fail("All approvals are complete. Reset this workflow to run again.");
        if (!await db().collection("correspondence").findOne({ _id: file.correspondenceId }, { session, projection: { _id: 1 } })) throw fail("Referenced correspondence no longer exists.");
        const task = await col("tasks").findOne({ fileId, stage: file.stage, status: "PENDING" }, { session });
        if (!task || !await col("officers").findOne({ _id: task.officerId }, { session })) throw fail("Pending task or assigned officer is missing.");
        const changed = await col("files").updateOne({ _id: fileId, version }, {
          $set: { stage: file.stage + 1, status: file.stage === 2 ? "COMPLETED" : "IN_PROGRESS", updatedAt: new Date() }, $inc: { version: 1 },
        }, { session });
        if (changed.modifiedCount !== 1) throw fail("Concurrent update rejected.");
        const done = await col("tasks").updateOne({ _id: task._id, status: "PENDING" }, { $set: { status: "DONE", completedAt: new Date() } }, { session });
        if (done.modifiedCount !== 1) throw fail("Task was already completed.");
        if (file.stage < 2) {
          const next = await col("tasks").updateOne({ fileId, stage: file.stage + 1, status: "WAITING" }, { $set: { status: "PENDING" } }, { session });
          if (next.modifiedCount !== 1) throw fail("Next approval stage is missing.");
        }
        if (rollback) throw Object.assign(new Error("Injected failure after workflow and task writes, before commit."), { injected: true });
        return { fromStage: STAGES[file.stage], version: version + 1, status: file.stage === 2 ? "COMPLETED" : "IN_PROGRESS" };
      }, TX);
    } finally { await session.endSession(); }
  }

  app.post("/api/workflow/setup", route(async (_req, res) => {
    if (setupRunning) throw fail("Setup is already running.");
    setupRunning = true;
    try {
      const existing = await col("meta").findOne({ _id: "setup", ready: true });
      if (existing) return res.json({ ...existing, reused: true });
      const files = await db().collection("correspondence").find({ probe: { $ne: true }, fileNo: { $type: "string" }, directorate: { $type: "string" } }, {
        projection: { _id: 1, fileNo: 1, directorate: 1 },
      }).sort({ _id: 1 }).limit(5000).toArray();
      if (files.length < 5000) throw fail(`Need 5,000 existing files; found ${files.length}. No correspondence was inserted.`, 400);
      const definitions = {
        files: schema(["correspondenceId", "fileNo", "directorate", "stage", "version", "status"], {
          correspondenceId: { bsonType: "objectId" }, fileNo: string, directorate: string,
          stage: { enum: [0, 1, 2, 3] }, version: { bsonType: ["int", "long"], minimum: 0 }, status: { enum: ["IN_PROGRESS", "COMPLETED"] },
        }),
        tasks: schema(["fileId", "stage", "officerId", "status", "dueAt"], {
          fileId: { bsonType: "objectId" }, stage: { enum: [0, 1, 2] }, officerId: string,
          status: { enum: ["WAITING", "PENDING", "DONE"] }, dueAt: { bsonType: "date" },
        }),
        officers: schema(["name", "directorate", "designation"], { name: string, directorate: string, designation: string }),
        dirs: schema(["name"], { name: string }),
      };
      for (const [key, validator] of Object.entries(definitions)) {
        try { await db().createCollection(names[key], { validator, validationLevel: "strict", validationAction: "error" }); }
        catch (error) {
          if (error.code !== 48) throw error;
          await db().command({ collMod: names[key], validator, validationLevel: "strict", validationAction: "error" });
        }
      }
      await col("files").createIndex({ correspondenceId: 1 }, { unique: true });
      await col("files").createIndex({ fileNo: 1 });
      await col("tasks").createIndex({ fileId: 1, stage: 1 }, { unique: true, name: "one_stage_per_file" });
      await col("tasks").createIndex({ status: 1, dueAt: 1 });
      const dirs = [...new Set(files.map(file => file.directorate))];
      await col("dirs").bulkWrite(dirs.map(dir => ({ updateOne: { filter: { _id: dir }, update: { $setOnInsert: { name: `${dir} Directorate` } }, upsert: true } })));
      await col("officers").bulkWrite(dirs.flatMap((dir, dirIndex) => STAGES.map((stage, index) => ({ updateOne: {
        filter: { _id: `${dir}:${index}` }, update: { $setOnInsert: { name: `Demo Officer ${dirIndex * 3 + index + 1}`, directorate: dir, designation: stage } }, upsert: true,
      } }))));
      for (let offset = 0; offset < files.length; offset += 250) {
        const batch = files.slice(offset, offset + 250);
        await col("files").bulkWrite(batch.map(file => ({ updateOne: { filter: { _id: file._id }, update: { $setOnInsert: {
          correspondenceId: file._id, fileNo: file.fileNo, directorate: file.directorate, stage: 0, version: 0, status: "IN_PROGRESS", updatedAt: new Date(),
        } }, upsert: true } })));
        await col("tasks").bulkWrite(batch.flatMap((file, index) => STAGES.map((_stage, stage) => ({ updateOne: {
          filter: { fileId: file._id, stage }, update: { $setOnInsert: {
            officerId: `${file.directorate}:${stage}`, status: stage === 0 ? "PENDING" : "WAITING",
            dueAt: new Date(Date.now() + ((offset + index) % 15 - 5 + stage * 2) * 86400000),
          } }, upsert: true,
        } }))));
      }
      const result = { ready: true, fileCount: files.length, taskCount: files.length * 3, officerCount: dirs.length * 3, directoryCount: dirs.length, preparedAt: new Date() };
      await col("meta").updateOne({ _id: "setup" }, { $set: result }, { upsert: true, writeConcern: { w: "majority" } });
      res.json(result);
    } finally { setupRunning = false; }
  }));

  app.get("/api/workflow/queue", route(async (req, res) => {
    const meta = await col("meta").findOne({ _id: "setup", ready: true });
    if (!meta) return res.json({ ready: false, rows: [], setupRunning });
    const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page, 10) || 1));
    const term = String(req.query.q || "").trim().slice(0, 100);
    const filter = term ? { fileNo: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {};
    const pipeline = [
      { $match: filter }, { $sort: { _id: 1 } }, { $skip: (page - 1) * 20 }, { $limit: 20 },
      { $lookup: { from: "correspondence", localField: "correspondenceId", foreignField: "_id", pipeline: [{ $project: { fileNo: 1, subject: 1, priority: 1, status: 1 } }], as: "correspondence" } },
      { $lookup: { from: names.tasks, localField: "_id", foreignField: "fileId", pipeline: [{ $sort: { stage: 1 } }], as: "tasks" } },
      { $lookup: { from: names.officers, localField: "tasks.officerId", foreignField: "_id", as: "officers" } },
      { $lookup: { from: names.dirs, localField: "directorate", foreignField: "_id", as: "directorateDetails" } },
    ];
    const [rows, total, report, completed, officers] = await Promise.all([
      col("files").aggregate(pipeline).toArray(), col("files").countDocuments(filter),
      col("tasks").aggregate([{ $match: { status: "PENDING" } }, { $group: {
        _id: "$officerId", pending: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ["$dueAt", new Date()] }, 1, 0] } },
      } }, { $sort: { _id: 1 } }]).toArray(), col("files").countDocuments({ status: "COMPLETED" }), col("officers").find({}).toArray(),
    ]);
    res.json({ ready: true, meta, rows, total, page, pageSize: 20, stages: STAGES, report, completed, officers, pipeline });
  }));

  app.post("/api/workflow/constraints", route(async (_req, res) => {
    await ready();
    const existing = await col("tasks").findOne({});
    const tests = [];
    const invalid = [
      ["Required field", { stage: 0, officerId: "demo", status: "PENDING", dueAt: new Date() }],
      ["Status enum", { ...existing, status: "NOT_A_STATUS" }],
      ["Date type", { ...existing, dueAt: "tomorrow" }],
    ];
    for (const [name, value] of invalid) {
      const candidate = { ...value, _id: new ObjectId(), fileId: new ObjectId() };
      if (name === "Required field") delete candidate.fileId;
      try { await col("tasks").insertOne(candidate); tests.push({ name, passed: false, error: "Invalid document was accepted" }); }
      catch (error) { tests.push({ name, passed: error.code === 121, code: error.code, error: error.message }); }
      finally { await col("tasks").deleteOne({ _id: candidate._id }); }
    }
    const duplicate = { ...existing, _id: new ObjectId() };
    try { await col("tasks").insertOne(duplicate); tests.push({ name: "Unique file + stage", passed: false }); }
    catch (error) { tests.push({ name: "Unique file + stage", passed: error.code === 11000, code: error.code, error: error.message }); }
    finally { await col("tasks").deleteOne({ _id: duplicate._id }); }
    res.json({ passed: tests.every(test => test.passed), tests, scope: "Strict validators and compound unique index on wf_tasks; correspondence is unchanged." });
  }));

  app.post("/api/workflow/:id/action", route(async (req, res) => {
    await ready();
    if (!ObjectId.isValid(req.params.id)) throw fail("Invalid workflow ID", 400);
    const fileId = new ObjectId(req.params.id);
    const { mode, version } = req.body;
    if (!["commit", "rollback", "concurrency", "reset"].includes(mode) || !Number.isSafeInteger(version) || version < 0) throw fail("Valid mode and version required", 400);
    if (mode === "reset") {
      const session = getClient().startSession();
      try {
        await session.withTransaction(async () => {
          const result = await col("files").updateOne({ _id: fileId, version }, { $set: { stage: 0, status: "IN_PROGRESS", updatedAt: new Date() }, $inc: { version: 1 } }, { session });
          if (result.modifiedCount !== 1) throw fail("Stale version: refresh the queue.");
          await col("tasks").updateMany({ fileId }, { $set: { status: "WAITING" }, $unset: { completedAt: "" } }, { session });
          await col("tasks").updateOne({ fileId, stage: 0 }, { $set: { status: "PENDING" } }, { session });
        }, TX);
      } finally { await session.endSession(); }
      return res.json({ passed: true, mode, after: await snapshot(fileId) });
    }
    const before = await snapshot(fileId);
    if (mode === "rollback") {
      let injected = false;
      try { await transition(fileId, version, true); }
      catch (error) { if (!error.injected) throw error; injected = true; }
      const after = await snapshot(fileId);
      return res.json({ mode, passed: injected && JSON.stringify(before) === JSON.stringify(after), before, after, outcome: "Injected failure; transaction aborted. Workflow and tasks must match the before state." });
    }
    if (mode === "concurrency") {
      const results = await Promise.allSettled([transition(fileId, version), transition(fileId, version)]);
      const after = await snapshot(fileId);
      const winners = results.filter(result => result.status === "fulfilled").length;
      return res.json({ mode, passed: winners === 1 && after.file.version === version + 1 && results.some(result => result.status === "rejected" && result.reason.status === 409), before, after,
        attempts: results.map((result, index) => ({ officer: index + 1, accepted: result.status === "fulfilled", detail: result.status === "fulfilled" ? result.value : result.reason.message })),
      });
    }
    const result = await transition(fileId, version);
    const after = await snapshot(fileId);
    res.json({ mode, passed: after.file.version === version + 1 && after.tasks.find(task => task.stage === before.file.stage)?.status === "DONE", result, before, after, transactionOptions: TX });
  }));
}