const workflowHelp = {
  prepare: {
    title: "Start Here: The Customer Walkthrough",
    proves: "A transactional approval application can reference the existing document corpus without re-ingesting it or regenerating embeddings.",
    steps: ["Prepare the workbench once. If it says 5,000 Files Prepared, setup is already complete.", "Select a file number in File Queue. The right-hand panel shows its three approval tasks.", "Present in this order: joined queue, schema and uniqueness, rollback, commit, concurrent approvals, and workload reporting.", "Reset the selected workflow before repeating approval demonstrations or when all stages are complete."],
    expected: "5,000 linked files, 15,000 tasks, and a small synthetic officer directory. Original correspondence and embeddings remain unchanged.",
    code: `const files = await db.collection("correspondence").find(
  { probe: { $ne: true }, fileNo: { $type: "string" },
    directorate: { $type: "string" } },
  { projection: { _id: 1, fileNo: 1, directorate: 1 } }
).sort({ _id: 1 }).limit(5000).toArray();

await db.collection("wf_files").updateOne(
  { _id: file._id },
  { $setOnInsert: {
    correspondenceId: file._id, fileNo: file.fileNo,
    directorate: file.directorate, stage: 0,
    version: 0, status: "IN_PROGRESS", updatedAt: new Date()
  } },
  { upsert: true }
);`,
    note: "Excerpt from setup: the backend repeats the upsert for each selected file and creates three tasks. Re-running setup reuses prepared data; it does not reset workflows.",
  },
  joins: {
    title: "Joins: One File, Multiple Collections",
    proves: "MongoDB aggregation joins related records with $lookup, comparable to SQL LEFT JOIN. The subject is read from existing correspondence, not copied into the workflow.",
    steps: ["Select a file number in the queue.", "Point to its subject, directorate, assigned officer, and approval stage. These fields come from different collections.", "Compare the selected file's three tasks and assigned officers in the right-hand panel.", "Expand Join Pipeline at the bottom of the page to show the full pipeline actually used for this queue."],
    expected: "The displayed row combines wf_files, correspondence, wf_tasks, wf_officers, and wf_directorates. Paging limits the join to 20 files at a time.",
    code: `db.wf_files.aggregate([
  { $sort: { _id: 1 } }, { $skip: 0 }, { $limit: 20 },
  { $lookup: {
    from: "correspondence", localField: "correspondenceId",
    foreignField: "_id",
    pipeline: [{ $project: { fileNo: 1, subject: 1, priority: 1, status: 1 } }],
    as: "correspondence"
  } },
  { $lookup: {
    from: "wf_tasks", localField: "_id", foreignField: "fileId",
    pipeline: [{ $sort: { stage: 1 } }], as: "tasks"
  } },
  { $lookup: {
    from: "wf_officers", localField: "tasks.officerId",
    foreignField: "_id", as: "officers"
  } },
  { $lookup: {
    from: "wf_directorates", localField: "directorate",
    foreignField: "_id", as: "directorateDetails"
  } }
]);`,
    note: "A join is not a foreign-key constraint. References are application-managed. The live pipeline also includes the current file-number filter and page offset.",
  },
  constraints: {
    title: "Structured Schema and Uniqueness",
    proves: "Database-enforced required fields, BSON types, enums, and a compound UNIQUE constraint reject invalid data even if application checks are bypassed.",
    steps: ["Click Test Schema & Uniqueness. It does not advance the selected file.", "In Execution Result, show the three schema checks: required field, status enum, and date type. Each must show PASS and code 121.", "Show Unique file + stage: PASS and code 11000 means the database rejected a duplicate approval stage.", "Expand Database Response to inspect the actual database errors."],
    expected: "Four PASS results. Invalid probes are rejected; probe IDs are cleaned up. This tests wf_tasks, not schema rules on the million-document corpus.",
    code: `db.createCollection("wf_tasks", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["fileId", "stage", "officerId", "status", "dueAt"],
    properties: {
      fileId: { bsonType: "objectId" },
      stage: { enum: [0, 1, 2] },
      officerId: { bsonType: "string", minLength: 1 },
      status: { enum: ["WAITING", "PENDING", "DONE"] },
      dueAt: { bsonType: "date" }
    }
  } }, validationLevel: "strict", validationAction: "error"
});
db.wf_tasks.createIndex(
  { fileId: 1, stage: 1 },
  { unique: true, name: "one_stage_per_file" }
);

const existing = db.wf_tasks.findOne();
db.wf_tasks.insertOne({ ...existing, _id: ObjectId(),
  fileId: ObjectId(), dueAt: "tomorrow" }); // code 121
db.wf_tasks.insertOne({ ...existing, _id: ObjectId() }); // code 11000`,
    note: "The other probes omit fileId or use status NOT_A_STATUS with a fresh fileId to isolate schema validation from uniqueness. The unique key is fileId + stage, not fileNo alone.",
  },
  rollback: {
    title: "Atomicity: All Changes or No Changes",
    proves: "A real multi-document transaction rolls back the workflow update and task updates together when an error occurs before commit.",
    steps: ["Select an unfinished file; use Reset Selected Workflow if needed.", "Note its version and PENDING / WAITING stages.", "Click Test Rollback. The backend writes the changes inside a transaction, then deliberately throws an error.", "Compare BEFORE and AFTER in Execution Result: version and every task status must be identical. PASS checks the complete snapshots."],
    expected: "Transaction rolled back, PASS. No approval stage advances and no version increment survives.",
    code: `const session = client.startSession();
try {
  await session.withTransaction(async () => {
    await advanceWorkflowAndTasks(session);
    throw new Error("Injected failure before commit");
  }, {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority", wtimeoutMS: 15000 },
    readPreference: "primary", maxCommitTimeMS: 15000
  });
} finally {
  await session.endSession();
}`,
    note: "Condensed Node.js driver example. advanceWorkflowAndTasks represents the actual workflow and task updates shown in the Approve Next Stage guide; every operation receives the same session. The driver aborts on the injected error.",
  },
  commit: {
    title: "ACID: Commit an Approval",
    proves: "The workflow, current task, and next task change in one transaction. Atomicity is demonstrated with rollback; consistency combines validators and business checks; snapshot reads support isolation; majority acknowledgement provides durability under normal replica-set failure assumptions.",
    steps: ["Select an unfinished file, or reset it first.", "Click Approve Next Stage.", "Show BEFORE and AFTER: version increases by one, current task becomes DONE, and the next task becomes PENDING.", "Repeat until Final Sanction completes: all three tasks become DONE and the workflow becomes COMPLETED."],
    expected: "Approval committed, PASS. Each click advances exactly one stage. The original correspondence registry status does not change.",
    code: `await session.withTransaction(async () => {
  const changed = await db.collection("wf_files").updateOne(
    { _id: fileId, version },
    { $set: {
        stage: file.stage + 1,
        status: file.stage === 2 ? "COMPLETED" : "IN_PROGRESS",
        updatedAt: new Date()
      }, $inc: { version: 1 } }, { session }
  );
  if (changed.modifiedCount !== 1) throw new Error("Concurrent update");
  await db.collection("wf_tasks").updateOne(
    { _id: task._id, status: "PENDING" },
    { $set: { status: "DONE", completedAt: new Date() } }, { session }
  );
  if (file.stage < 2) await db.collection("wf_tasks").updateOne(
    { fileId, stage: file.stage + 1, status: "WAITING" },
    { $set: { status: "PENDING" } }, { session }
  );
}, {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority", wtimeoutMS: 15000 },
  readPreference: "primary", maxCommitTimeMS: 15000
});`,
    note: "Backend excerpt, condensed: it also checks the expected version, file completion, source correspondence, assigned officer, pending task, and affected task counts. This is not serializable isolation or a failover durability test. Use the existing Resilience demo for failover evidence.",
  },
  concurrency: {
    title: "Concurrency: Prevent a Lost Update",
    proves: "Two simulated officers submit the same expected version. Optimistic concurrency plus transactions allows one approval and rejects the stale attempt.",
    steps: ["Reset the selected workflow to make the result easy to follow.", "Note its current version, then click Race Two Approvals once.", "Show Officer 1 and Officer 2 results: one COMMITTED and one REJECTED. Either officer can win.", "Compare BEFORE and AFTER: version increased by only one and only one stage advanced."],
    expected: "PASS means exactly one transaction committed, the version advanced once, and the loser was rejected as a conflict. This action really advances one stage.",
    code: `const results = await Promise.allSettled([
  transition(fileId, version),
  transition(fileId, version)
]);

// Inside each transition, using its own session / transaction:
const file = await db.collection("wf_files").findOne(
  { _id: fileId }, { session }
);
if (file.version !== version) throw conflict("Stale version");
const changed = await db.collection("wf_files").updateOne(
  { _id: fileId, version },
  { $set: { stage: file.stage + 1 }, $inc: { version: 1 } },
  { session }
);
if (changed.modifiedCount !== 1) throw conflict("Concurrent update");`,
    note: "Condensed excerpts. transition performs the full approval shown in the commit guide. The driver may retry transient write conflicts; a retry reads the newer version and rejects the stale request. These are simulated attempts, not authenticated officer sessions.",
  },
  reset: {
    title: "Reset a Workflow for Another Demonstration",
    proves: "A repeatable demo can reset related workflow records transactionally without changing the source file.",
    steps: ["Select the file used for the demonstration.", "Click Reset Selected Workflow.", "Verify Section Review is PENDING and the other two stages are WAITING.", "Repeat rollback, commit, or concurrent-approval demonstrations."],
    expected: "Stage returns to zero, completed timestamps are cleared, and version increases rather than returning to zero. Only the selected workflow is reset.",
    code: `await session.withTransaction(async () => {
  const result = await db.collection("wf_files").updateOne(
    { _id: fileId, version },
    { $set: { stage: 0, status: "IN_PROGRESS", updatedAt: new Date() },
      $inc: { version: 1 } }, { session }
  );
  if (result.modifiedCount !== 1) throw new Error("Stale version");
  await db.collection("wf_tasks").updateMany(
    { fileId },
    { $set: { status: "WAITING" }, $unset: { completedAt: "" } },
    { session }
  );
  await db.collection("wf_tasks").updateOne(
    { fileId, stage: 0 }, { $set: { status: "PENDING" } }, { session }
  );
}, transactionOptions);`,
    note: "This is a demo reset, not a production business approval reversal. Keeping the version increasing prevents older requests from becoming valid again.",
  },
  reporting: {
    title: "Reporting: GROUP BY and Conditional Counts",
    proves: "MongoDB aggregation computes operational reports over the same task data, comparable to SQL WHERE, GROUP BY, COUNT, and conditional SUM.",
    steps: ["Show Officer Workload: pending and overdue tasks are grouped by assigned officer across all 5,000 files, not just the visible page.", "Note the selected file's assigned officer and the workload count.", "Approve its next stage, then return to the report. One pending task moves from the current officer to the next, or disappears at final completion.", "Compare Pending Approvals and Completed Files at the top of the page."],
    expected: "The queue and report refresh after each action. Only PENDING tasks are counted; WAITING and DONE tasks are excluded. An overdue task has dueAt earlier than the current time.",
    code: `db.wf_tasks.aggregate([
  { $match: { status: "PENDING" } },
  { $group: {
    _id: "$officerId",
    pending: { $sum: 1 },
    overdue: { $sum: { $cond: [
      { $lt: ["$dueAt", new Date()] }, 1, 0
    ] } }
  } },
  { $sort: { _id: 1 } }
]);`,
    note: "Officer names are resolved from the officer directory. Due dates and officers are synthetic demonstration data; file numbers and subjects reference existing correspondence.",
  },
  evidence: {
    title: "Read the Evidence, Not Just the PASS Label",
    proves: "Each control returns an observable database outcome: rejection codes, state snapshots, or results of competing transactions.",
    steps: ["Run one of the Business Integrity actions.", "Read the named result and PASS / FAIL verdict.", "For rollback, compare identical before/after versions and tasks. For commit, compare one stage advancement. For concurrency, verify one accepted attempt.", "Expand Database Response to show the returned data and exact database errors for constraint probes."],
    expected: "The evidence belongs to the last action only. A help button does not run an action, alter a workflow, or clear its result.",
    code: `const rollbackPassed = injectedFailure &&
  JSON.stringify(before) === JSON.stringify(after);

const concurrencyPassed =
  results.filter(result => result.status === "fulfilled").length === 1 &&
  after.file.version === version + 1 &&
  results.some(result => result.status === "rejected" &&
    result.reason.status === 409);

const schemaPassed = error.code === 121;
const uniquenessPassed = error.code === 11000;`,
    note: "These checks validate this workflow demonstration. They do not constitute a general proof of production security, native foreign-key enforcement, or all failure scenarios.",
  },
};

const helpDialog = document.getElementById("help-dialog");
const helpTargets = [
  ["#prepare", "prepare", false], [".queue h2", "joins", false],
  ["#constraints", "constraints", true], ["#rollback", "rollback", true],
  ["#commit", "commit", true], ["#concurrency", "concurrency", true],
  ["#reset", "reset", true], [".report h2", "reporting", false],
  [".evidence h2", "evidence", false],
];
for (const [selector, topic, wrap] of helpTargets) {
  const target = document.querySelector(selector);
  if (wrap) {
    const row = document.createElement("div");
    row.className = "action-help-row";
    target.before(row);
    row.append(target);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "info-button";
  button.textContent = "i";
  button.dataset.help = topic;
  button.title = workflowHelp[topic].title;
  button.setAttribute("aria-label", `Explain ${workflowHelp[topic].title}`);
  button.setAttribute("aria-haspopup", "dialog");
  button.onclick = () => {
    const guide = workflowHelp[topic];
    document.getElementById("help-title").textContent = guide.title;
    const content = document.getElementById("help-content");
    content.replaceChildren();
    function section(title, text) {
      const heading = document.createElement("h3");
      heading.textContent = title;
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      content.append(heading, paragraph);
    }
    section("What This Proves", guide.proves);
    const heading = document.createElement("h3");
    heading.textContent = "How to Demonstrate";
    const steps = document.createElement("ol");
    for (const step of guide.steps) {
      const item = document.createElement("li");
      item.textContent = step;
      steps.append(item);
    }
    content.append(heading, steps);
    section("Expected Evidence", guide.expected);
    const codeHeading = document.createElement("h3");
    codeHeading.textContent = "MongoDB Code";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = guide.code;
    pre.append(code);
    content.append(codeHeading, pre);
    section("Scope and Caveats", guide.note);
    helpDialog.showModal();
    helpDialog.scrollTop = 0;
  };
  target.after(button);
}
document.getElementById("help-close").onclick = () => helpDialog.close();