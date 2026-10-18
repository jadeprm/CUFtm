/**
 * The Neon driver, pointed at a local Postgres.
 *
 * lib/db.js talks to Neon over HTTP (`neon(connectionString)`), which in
 * production is exactly right and on a laptop is a dead end: the driver turns
 * postgres://…@127.0.0.1:5432/fairv2 into https://api.0.0.1/sql and fails to
 * parse its own URL. Everything here is development scaffolding — it is
 * imported by srv2.mjs and test/run.mjs and by nothing that ships.
 *
 * It stands up a tiny server that speaks the same HTTP protocol Neon's
 * endpoint does and runs the SQL through `pg`. The one subtlety: Neon returns
 * column values as raw text and the driver parses them itself, so pg's own
 * parsers are turned off (`getTypeParser` returning the value untouched) —
 * otherwise a timestamp would be parsed twice and come back as a string of a
 * Date, and `count(*)` would arrive as a number where the driver expects the
 * digits.
 */
import http from 'node:http';
import pg from 'pg';
import { neonConfig } from '@neondatabase/serverless';

const PORT = Number(process.env.NEON_LOCAL_PORT || 4799);
const CONNECTION = process.env.DATABASE_URL ||
  'postgres://postgres:pw@127.0.0.1:5432/fairv2';

const pool = new pg.Pool({
  connectionString: CONNECTION,
  max: 8,
  types: { getTypeParser: () => (value) => value },
});

const runOne = async (body) => {
  const result = await pool.query({
    text: body.query,
    values: body.params || [],
    rowMode: 'array',
  });
  return {
    command: result.command,
    rowCount: result.rowCount,
    rows: result.rows,
    fields: (result.fields || []).map((f) => ({
      name: f.name, dataTypeID: f.dataTypeID, tableID: f.tableID,
      columnID: f.columnID, dataTypeSize: f.dataTypeSize,
      dataTypeModifier: f.dataTypeModifier, format: f.format,
    })),
  };
};

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const body = JSON.parse(raw || '{}');
    if (Array.isArray(body.queries)) {
      const results = [];
      // A batch is a transaction, the same as it is on Neon.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const q of body.queries) {
          const r = await client.query({ text: q.query, values: q.params || [], rowMode: 'array' });
          results.push({
            command: r.command, rowCount: r.rowCount, rows: r.rows,
            fields: (r.fields || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
          });
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return send(200, { results });
    }
    return send(200, await runOne(body));
  } catch (error) {
    return send(400, {
      message: error.message, code: error.code, detail: error.detail,
      severity: error.severity || 'ERROR', position: error.position,
    });
  }
});

/**
 * A port already in use means another dev process is running one of these —
 * srv2.mjs, usually, while a suite starts beside it. Theirs will do.
 */
const listening = await new Promise((resolve) => {
  server.once('error', (error) => resolve(error.code !== 'EADDRINUSE' ? Promise.reject(error) : false));
  server.listen(PORT, '127.0.0.1', () => resolve(true));
});
if (listening) server.unref(); else await pool.end().catch(() => {});

neonConfig.fetchEndpoint = () => `http://127.0.0.1:${PORT}/sql`;
neonConfig.poolQueryViaFetch = true;
neonConfig.useSecureWebSocket = false;

export const neonLocalPort = PORT;
