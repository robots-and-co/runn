'use strict';

// READ-ONLY lthcs-ops tool: db_health_check({ site })
//
// Runs the Firebird `gstat -h <db_path>` header probe over SSH. `gstat -h`
// is a header-only read — it does not mutate the database — making it the
// canonical "is the file there and consistent at the header level?" check.
//
// `db_path` (and optionally `db_gstat_cmd`) live in the local site config;
// the model never supplies a path. A site without these fields cannot be
// probed by this tool.
//
// Result schema (success):
//   { ok: true,
//     ods_version?:       "12.0",
//     page_size?:         8192,
//     oldest_active?:     integer,
//     next_transaction?:  integer,
//     tx_lag?:            integer >= 0 }   // next_transaction - oldest_active
//
// Errors: { error: "site_not_configured_for_db_health" |
//                   "db_header_read_failed" |
//                   "db_header_unparseable" }

const { sshBaseArgs, run, shellQuote } = require('./_ssh');

const NAME = 'db_health_check';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'Read-only Firebird database header probe (gstat -h). Returns ODS ' +
  'version, page size and transaction counters. Does not write to the ' +
  'database; no paths or hostnames are returned.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: { site: { enum: siteNames } },
    required: ['site'],
    additionalProperties: false,
  };
}

// Pull a labelled numeric/string field out of gstat header output. gstat
// indents key/value pairs and separates them with whitespace, e.g.:
//   "    Page size                8192"
//   "    ODS version              12.0"
//   "    Oldest active            4711"
//   "    Next transaction         4719"
function findField(stdout, label) {
  // Anchor on a line that contains `<label>` followed by whitespace and a
  // value token. Case-insensitive so capitalisation drift doesn't break us.
  const re = new RegExp(`^\\s*${label}\\s+(\\S+)\\s*$`, 'im');
  const m = re.exec(stdout);
  return m ? m[1] : null;
}

function parseHeader(stdout) {
  const out = {};
  const ods = findField(stdout, 'ODS version');
  if (ods) out.ods_version = ods;

  const pageSize = Number(findField(stdout, 'Page size'));
  if (Number.isInteger(pageSize) && pageSize > 0) out.page_size = pageSize;

  const oldest = Number(findField(stdout, 'Oldest active'));
  if (Number.isInteger(oldest) && oldest >= 0) out.oldest_active = oldest;

  const next = Number(findField(stdout, 'Next transaction'));
  if (Number.isInteger(next) && next >= 0) out.next_transaction = next;

  if (out.oldest_active !== undefined && out.next_transaction !== undefined) {
    out.tx_lag = Math.max(0, out.next_transaction - out.oldest_active);
  }
  return out;
}

async function handler(args, { sites }) {
  const site = sites[args && args.site];
  if (!site) return { error: 'unknown_site' };

  if (!site.db_path) return { error: 'site_not_configured_for_db_health' };
  const gstat = site.db_gstat_cmd || 'gstat';

  // Both `gstat` and the db path get single-quoted. They come from the
  // operator's config, never the model — but quoting still defends
  // against an accidental space in a Windows-style path.
  const remote = `${shellQuote(gstat)} -h ${shellQuote(site.db_path)}`;
  const res = await run(
    'ssh', [...sshBaseArgs(site), remote],
    { timeoutMs: 20000 },
  );
  if (!res.ok) return { error: 'db_header_read_failed' };

  const fields = parseHeader(res.stdout);
  // A header read that finds none of the canonical fields means we
  // probably ran against something that isn't a Firebird database — return
  // an explicit error rather than `{ok:true}` with no detail.
  if (!fields.ods_version && fields.page_size === undefined) {
    return { error: 'db_header_unparseable' };
  }
  return { ok: true, ...fields };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: { parseHeader, findField },
};
