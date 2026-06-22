'use strict';

// Session-scoped plan store for the lthcs-ops MCP server. Implements the
// plan-then-apply contract from CLIENT_OPS_MCP_DESIGN.md §5 (now closed): the
// model first proposes the exact operation via a `*_plan` tool, the operator
// reviews it, and a single `apply_plan({ plan_id, reason })` call executes it.
//
// Why a separate store: each `*_plan` tool resolves and *freezes* the dynamic
// values of an operation (snapshot tag epoch, ordered command list, affected
// datasets). The apply step then runs that frozen plan rather than re-deriving
// it — otherwise "approve" would be approving an *intent*, not the concrete
// action, and a long delay between plan and apply would silently change the
// resolved tag/timestamp out from under the operator. Freezing is the whole
// point of plan-then-apply.
//
// Scope: in-memory Map<plan_id, envelope>. The lthcs-ops server is spawned
// per-Claude-session (worker/bridge.js), so this Map IS the session-scoped
// storage the spec asked for — it dies with the subprocess at session end.
// No cross-session reuse, no persistence to disk.
//
// Worker enrichment: each plan registers a sanitised "model view" of itself
// with the worker via POST /plans/register. When the model later calls
// apply_plan, the CLI's permission gate posts to the worker, which looks the
// plan up by id and enriches the broadcast input with the full plan body
// BEFORE rendering the approval card. That is how the approval prompt
// "surfaces the full original plan, not just the plan id" — the body the
// operator reviews is the same one the model saw on the planning turn,
// looked up server-side rather than re-shipped by the model (which could,
// in principle, tamper with it on the way back). Tamper-resistance is the
// second prize.
//
// Leak invariants:
//   * The model_view embedded in each envelope contains only what the model
//     already had in scope — site_label (abstract), dataset (model-supplied),
//     remote_command strings for verbs whose body is non-secret (e.g.
//     `zfs snapshot pool0/winvm@<tag>`). For verbs whose remote command is a
//     site-config secret (kick/kill templates, service status/restart cmds),
//     model_view describes them abstractly ("configured kick command for
//     site A") and the raw text is kept in the envelope's private fields
//     for the executor to use at apply time. That keeps the approval card
//     payload at parity with what the model would see calling the tool
//     directly, no leak widening.
//   * The envelope's private fields (sites_lookup keys, raw commands) stay
//     on-box; they never get sent to /plans/register and never get returned
//     to the model.

const crypto = require('crypto');
const http = require('http');

const RUNN_PORT  = process.env.RUNN_PORT  || '17778';
const RUNN_HOST  = process.env.RUNN_HOST  || '127.0.0.1';
const REQ_TOKEN  = process.env.RUNN_PERMISSION_TOKEN || '';

// plan_id → envelope. Process-local, wiped on exit.
const PLANS = new Map();

function mintPlanId() {
  // 16 bytes = 128 bits, unguessable. Prefixed so plan_ids are visually
  // distinct from session_ids in logs / transcripts.
  return `plan_${crypto.randomBytes(16).toString('hex')}`;
}

// Build a plan envelope. `model_view` is what the model + approval card see;
// `private` is server-side execution state.
function makeEnvelope({ tool, site_label, reason, affects, steps_model_view, executor_state }) {
  const created_at = new Date().toISOString();
  const plan_id = mintPlanId();
  const envelope = {
    plan_id,
    tool,
    created_at,
    site_label,
    reason,
    affects,
    steps: steps_model_view,
    // Private — never serialised in toModelView, never POSTed.
    _executor_state: executor_state,
  };
  PLANS.set(plan_id, envelope);
  return envelope;
}

// The shape the model and the operator's approval card see. Everything in here
// is at parity with what the model would normally see calling the tool
// directly — no host/user/key/raw-secret-cmd. The plan_id makes it look up-able
// for the apply step.
function toModelView(envelope) {
  return {
    plan_id: envelope.plan_id,
    tool: envelope.tool,
    created_at: envelope.created_at,
    site_label: envelope.site_label,
    reason: envelope.reason,
    affects: envelope.affects.slice(),
    steps: envelope.steps.map(s => ({ ...s })),
  };
}

function getPlan(plan_id) {
  if (typeof plan_id !== 'string') return null;
  return PLANS.get(plan_id) || null;
}

function deletePlan(plan_id) {
  PLANS.delete(plan_id);
}

// Best-effort POST to the worker so the permission card can look up the body
// when the model later calls apply_plan. A failure here is non-fatal — the
// plan is still usable from the model's side, and the operator still sees the
// plan body in the chat (it's the tool result the model is returning). The
// degraded mode is just "approval card shows {plan_id, reason} only" rather
// than the full body. Logged to stderr so a misconfigured RUNN_PORT shows up
// in the session log.
function registerWithWorker(envelope) {
  return new Promise((resolve) => {
    const view = toModelView(envelope);
    const data = JSON.stringify({ token: REQ_TOKEN, plan_id: envelope.plan_id, plan: view });
    const req = http.request({
      hostname: RUNN_HOST, port: RUNN_PORT,
      path: '/plans/register', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      // Drain so the socket can close.
      res.on('data', () => {});
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode }));
    });
    req.on('error', (err) => {
      process.stderr.write(
        `lthcs-ops: plan register failed (${envelope.plan_id}): ${err.message}\n`
      );
      resolve({ ok: false, error: err.message });
    });
    req.write(data);
    req.end();
  });
}

module.exports = {
  makeEnvelope,
  toModelView,
  getPlan,
  deletePlan,
  registerWithWorker,
  _internals: { mintPlanId, PLANS },
};
