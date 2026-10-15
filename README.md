# eOffice 2.0 — MongoDB Replica Set PoC (2:2:1, 3 regions)

5-node replica set simulating DC1 (2 nodes) / DC2 (2 nodes) / DR (1 node), with a web
dashboard to run each RFP-mapped test one by one.

## Prerequisites

- Docker Desktop, Node.js 18+
- One-time hosts entry so the host can resolve replica set members:

```bash
echo '127.0.0.1 host.docker.internal' | sudo tee -a /etc/hosts
```

## Run

```bash
./scripts/gen-keyfile.sh        # 1. keyfile for intra-cluster auth
docker compose up -d            # 2. start 5 mongod nodes
./scripts/init.sh               # 3. initiate rs0, users, roles, indexes
cd app && npm install && npm start   # 4. dashboard
```

Open http://localhost:3000

## Demo script (suggested order)

1. **Topology** — show 5 members, regions, priorities (DC1 > DC2 > DR), ping, lag.
2. **Seed** — 100K–1M docs (Appx L #6 corpus).
3. **P99 latency** — reads then writes; target < 10ms (Appx D 3.2).
4. **Write concern** — w:1 vs w:majority durability premium.
5. **Zero data loss** — start the 30s write loop, then click **stop** on the PRIMARY
   row (or **Kill DC1**). Watch election + retryable writes ride through;
   verdict shows acked == found and the stall window (= failover time).
6. **Restore** the stopped nodes; watch them rejoin and catch up (lag column).
7. **Read by region** — serve reads from DC2/DR via tags.
8. **Immutability** — audituser can insert/read audit_log but update/delete are denied.
9. **Audit trail** — change stream captures old + new values into audit_log.
10. **Search** — indexed full-text over the corpus with latency shown.
11. **Op latencies** — server-side per-node DB-layer latency evidence.

## Approval Workbench

Open `/workflow.html` or select **Approval Workbench** from the dashboard.
Click **Prepare 5,000 Files** once. Setup links 5,000 existing correspondence
records to 15,000 synthetic approval tasks and a small synthetic officer directory.
It is repeatable and resumes partial setup without resetting completed approvals.
It does not insert, update, re-embed, or add indexes to `correspondence`.

Suggested customer walkthrough:

1. Select a file in the queue. Its subject and registry status come from existing
   correspondence; officers, directorates, and tasks are joined using `$lookup`.
   Expand **Join Pipeline** to show the actual pipeline.
2. Click **Test Schema & Uniqueness**. Required-field, enum, and date violations
   return database code 121; duplicate file/stage returns 11000. Probe records
   are removed, and the checks verify the expected error codes.
3. Click **Test Rollback**. An injected failure after writes aborts the transaction;
   the displayed workflow and tasks remain identical to their before state.
4. Click **Approve Next Stage**. Workflow version, completed task, and next pending
   task change together using snapshot read concern and majority write concern.
5. Click **Race Two Approvals**. Two real transactions submit the same version;
   exactly one commits and the other is rejected as stale. This advances one stage.
6. Use **Reset Selected Workflow** to repeat, and show **Officer Workload** for
   grouped pending and overdue task counts across all 5,000 files.

The three stages are Section Review, Directorate Approval, and Final Sanction.
All workflow writes are isolated to `wf_*` collections. These validators and the
compound uniqueness constraint apply to workflow data, not the original corpus.
References are application-managed, not native foreign keys. The workbench is a
demo, not an authenticated approval system; restrict its network access as for
the existing administrative dashboard. It is not a durability/failover test.

Verification:

```bash
node --test app/workflow.test.js
WORKFLOW_BASE_URL=http://localhost:3000 node --test app/workflow.test.js
```

The live test prepares data if needed and exercises/reset one workflow. When
`MONGO_URL` is also set, it checks actual workflow counts and verifies that the
selected correspondence document, including any embedding, is unchanged.

## Reconnect From a Different Network

On your Mac, run:

```bash
bash aws/connect-demo.sh
```

Keep the terminal open, then visit `http://127.0.0.1:8080/workflow.html`
for the workbench, `http://127.0.0.1:8080/` for the dashboard, or
`http://127.0.0.1:8081/` for Ops Manager. After switching Wi-Fi or changing
public IP, stop the old tunnel with Ctrl-C and run the command again.

The command looks up EC2's current public IP, adds your current public IPv4
as a `/32` rule for SSH only in the named demo security group, and opens
loopback-only SSH forwards. It does not require public access to dashboard
ports or remove existing rules. Remove obsolete IP rules periodically to
avoid accumulating permissions or reaching security-group rule limits.

You need the SSH key and valid AWS CLI credentials with permission to describe
the instance and authorize security-group ingress. For an SSO profile, log in
with `aws sso login --profile YOUR_PROFILE` and run the command with
`AWS_PROFILE=YOUR_PROFILE`. A tunnel alone cannot bypass a blocked SSH rule.
Use `bash aws/connect-demo.sh --check` for a read-only readiness check.
If a local port is occupied, use `DEMO_PORT=8082 OPS_PORT=8083 bash aws/connect-demo.sh`.

The approval workflow runs on EC2 independently of your Mac. Corporate LLM
access is separate: AI answers still require the existing `aws/llm-tunnel.sh`
reverse tunnel and the Mac's access to the corporate gateway.

## Credentials

- admin / eoffice123 (root) · audituser / audit123 (append-only on poc.audit_log)

## Teardown

```bash
docker compose down -v
```
