import test from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { registerWorkflowRoutes } from "./workflow.js";

test("workflow routes register without connecting or writing", () => {
  const routes = [];
  const app = { get: path => routes.push(path), post: path => routes.push(path) };
  registerWorkflowRoutes(app, { getClient: () => { throw new Error("Unexpected connection"); } });
  assert.deepEqual(routes, ["/api/workflow/setup", "/api/workflow/queue", "/api/workflow/constraints", "/api/workflow/:id/action"]);
});

test("live 5,000-file integrity walkthrough", { skip: !process.env.WORKFLOW_BASE_URL, timeout: 240000 }, async () => {
  const base = process.env.WORKFLOW_BASE_URL.replace(/\/$/, "");
  async function request(path, body, expectedStatus = 200) {
    const response = await fetch(`${base}/api/workflow/${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(data));
    return data;
  }
  const setup = await request("setup", {});
  assert.equal(setup.fileCount, 5000);
  assert.equal(setup.taskCount, 15000);
  assert.equal((await request("setup", {})).reused, true);
  const queue = await request("queue");
  assert.equal(queue.total, 5000);
  assert.equal(queue.rows.length, 20);
  assert.equal(queue.pipeline.filter(stage => stage.$lookup).length, 4);
  const row = queue.rows[0];
  assert.equal(row.correspondence.length, 1);
  assert.equal(row.tasks.length, 3);
  assert.equal(row.officers.length, 3);
  assert.equal(row.directorateDetails.length, 1);
  assert.equal(row.correspondence[0].embedding, undefined);
  const match = await request(`queue?q=${encodeURIComponent(row.fileNo)}`);
  assert.ok(match.rows.some(item => item._id === row._id));
  assert.equal((await request("queue?q=%5B.%2A%5D")).total, 0);
  const constraints = await request("constraints", {});
  assert.equal(constraints.passed, true);
  assert.deepEqual(constraints.tests.map(result => result.code), [121, 121, 121, 11000]);
  let client;
  let source;
  try {
    if (process.env.MONGO_URL) {
      client = new MongoClient(process.env.MONGO_URL);
      await client.connect();
      source = await client.db("poc").collection("correspondence").findOne({ _id: new ObjectId(row.correspondenceId) });
    }
    const action = (mode, version, code) => request(`${row._id}/action`, { mode, version }, code);
    let result = await action("reset", row.version);
    let version = result.after.file.version;
    result = await action("rollback", version);
    assert.equal(result.passed, true);
    assert.deepEqual(result.before, result.after);
    result = await action("concurrency", version);
    assert.equal(result.passed, true);
    assert.equal(result.attempts.filter(attempt => attempt.accepted).length, 1);
    await action("commit", version, 409);
    version = result.after.file.version;
    assert.equal(result.after.tasks.filter(task => task.status === "DONE").length, 1);
    for (let stage = 1; stage < 3; stage++) {
      result = await action("commit", version);
      assert.equal(result.passed, true);
      version = result.after.file.version;
    }
    assert.equal(result.after.file.status, "COMPLETED");
    assert.ok(result.after.tasks.every(task => task.status === "DONE"));
    await action("commit", version, 409);
    result = await action("reset", version);
    assert.equal(result.after.file.stage, 0);
    assert.equal(result.after.tasks.filter(task => task.status === "PENDING").length, 1);
    assert.equal((await request("setup", {})).reused, true);
    if (client) {
      const after = await client.db("poc").collection("correspondence").findOne({ _id: new ObjectId(row.correspondenceId) });
      assert.deepEqual(after, source, "Correspondence, including any embeddings, must not change");
      assert.equal(await client.db("poc").collection("wf_files").countDocuments(), 5000);
      assert.equal(await client.db("poc").collection("wf_tasks").countDocuments(), 15000);
    }
  } finally { await client?.close(); }
});