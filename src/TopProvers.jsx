import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Three specific provers we care about.
 */
function parseCycles(value) {
  if (value == null) return 0;
  const str = String(value).trim();
  // remove commas and units like K, M, B, T
  const match = str.match(/^([\d.]+)/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : 0;
}


const PROVERS = [
  { label: "Prover 1", addr: "0x6220892679110898abd78847d6f0a639e3408dc7" },
  { label: "Prover 2", addr: "0x34a2df023b535c1bd79a791b259adea947f603e3" },
  { label: "Prover 3", addr: "0x11973257c9210d852084f7b97f672080c1dbbb53" },
];

/**
 * Builds a Railway SQL API URL that returns, for Base mainnet only:
 *  - orders_taken (COUNT of orders per prover_addr)
 *  - cycles_proved (SUM of orders_executions.total_cycles)
 * for the 3 given prover addresses.
 *
 * NOTE: We pass all params positionally to keep the query safe and cacheable.
 */
function buildSQLUrl() {
  const sql = `
    select
      "orders"."prover_addr" as prover_addr,
      count("orders"."order_id")::bigint as orders_taken,
      coalesce(sum(coalesce("orders_executions"."total_cycles", 0)), 0)::bigint as cycles_proved
    from "orders"
    left join "orders_executions"
      on "orders_executions"."order_id" = "orders"."order_id"
    where "orders"."chain" in ($1)
      and "orders"."prover_addr" in ($2, $3, $4)
    group by "orders"."prover_addr"
  `.trim();

  const params = [
    "base_mainnet",
    PROVERS[0].addr.toLowerCase(),
    PROVERS[1].addr.toLowerCase(),
    PROVERS[2].addr.toLowerCase(),
  ];

  const payload = {
    json: {
      sql,
      params,
      typings: ["none", "none", "none", "none"],
    },
  };

  const q = encodeURIComponent(JSON.stringify(payload));
  return `https://boundless.up.railway.app/sql/db?sql=${q}`;
}

/**
 * Determine if it's time (in UTC) to take a snapshot:
 * Every 2 hours from 10:00 UTC onwards (i.e., 10, 12, 14, ... 22, 00, 02, 04, 06, 08 also match after midnight rolls over).
 * We only allow one snapshot per (UTC date, hour) bucket.
 */
function isSnapshotWindow(now = new Date()) {
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  // Eligible hours are those congruent to 10 mod 2 (i.e., all even hours if 10:00 is the anchor)
  const anchorOk = (h - 10 + 24) % 2 === 0;
  // Only fire in the first 5 minutes of the window to avoid duplicates if the page stays open
  const minuteOk = m < 5;
  return anchorOk && minuteOk;
}

function snapshotBucketKey(now = new Date()) {
  // One snapshot per hour bucket: YYYY-MM-DDTHH:00Z
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:00Z`;
}

const STORAGE_KEY = "boundless_prover_metrics_snapshots_v1";

/**
 * Persist snapshot locally (always), and optionally POST to a backend if configured.
 */
async function persistSnapshot(snapshot) {
  // 1) localStorage ring buffer-ish store
  try {
    const prev = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    prev.push(snapshot);
    // keep only last 1000 records to cap growth
    if (prev.length > 1000) prev.splice(0, prev.length - 1000);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prev));
  } catch (e) {
    // non-fatal
    console.warn("Failed to persist to localStorage", e);
  }

  // 2) optional POST to your backend (prefer .env Vite style, fallback to window.ENV)
  const endpoint =
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      import.meta.env.VITE_METRICS_ENDPOINT) ||
    (typeof window !== "undefined" &&
      window.ENV &&
      window.ENV.METRICS_ENDPOINT) ||
    null;

  if (!endpoint) return; // nothing configured

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
  } catch (e) {
    console.warn("Failed to POST snapshot to backend", e);
  }
}

export default function TopProvers() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const lastBucketRef = useRef(null);

  const apiUrl = useMemo(buildSQLUrl, []);

  // Fetch current metrics
  useEffect(() => {
    let stop = false;

    async function fetchData() {
      try {
        setError(null);
        const res = await fetch(apiUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch (${res.status})`);
        const json = await res.json();
        const data = json?.rows || json?.data || [];

        // Normalise into complete set for the 3 provers
        const byAddr = Object.fromEntries(
          data.map((r) => [
            (r.prover_addr || "").toLowerCase(),
            {
              orders_taken: Number(r.orders_taken || 0),
              cycles_proved: parseCycles(r.cycles_proved),
            },
          ])
        );

        const table = PROVERS.map((p) => ({
          label: p.label,
          addr: p.addr,
          orders_taken: byAddr[p.addr.toLowerCase()]?.orders_taken ?? 0,
          cycles_proved: byAddr[p.addr.toLowerCase()]?.cycles_proved ?? 0,
        }));

        if (!stop) setRows(table);
      } catch (e) {
        console.error(e);
        if (!stop) setError(e.message || String(e));
      } finally {
        if (!stop) setLoading(false);
      }
    }

    fetchData();

    // Refresh live metrics every 60s for the UI (cheap; SQL is aggregated)
    const t = setInterval(fetchData, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [apiUrl]);

  // Snapshot job: every minute check if we're in the [00..04] minute of a valid 2-hour UTC boundary from 10:00 onwards.
  useEffect(() => {
    function maybeSnapshot() {
      if (!rows.length) return;
      const now = new Date();
      if (!isSnapshotWindow(now)) return;

      const bucket = snapshotBucketKey(now);
      if (lastBucketRef.current === bucket) return; // already wrote this bucket during this session

      lastBucketRef.current = bucket;

      const payload = {
        bucket, // e.g., 2025-10-29T12:00Z
        captured_at: now.toISOString(),
        provers: rows.map((r) => ({
          label: r.label,
          addr: r.addr,
          orders_taken: r.orders_taken,
          cycles_proved: r.cycles_proved,
        })),
      };

      // Fire and forget
      persistSnapshot(payload);
    }

    const t = setInterval(maybeSnapshot, 60_000);
    // run once on mount so you don’t have to wait a minute during testing
    setTimeout(maybeSnapshot, 500);

    return () => clearInterval(t);
  }, [rows]);

  if (loading) return <p>Loading prover metrics…</p>;
  if (error) return <p style={{ color: "red" }}>Error: {error}</p>;

  return (
    <div style={{ padding: 20 }}>
      <h2>Selected Provers — Orders & Cycles</h2>
      <p style={{ marginTop: -6, color: "#666" }}>
        Live metrics from Base mainnet. Snapshots taken every 2 hours UTC starting at 10:00.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", minWidth: 720 }}>
          <thead>
            <tr>
              <th style={th}>Prover</th>
              <th style={th}>Address</th>
              <th style={thRight}>Orders taken</th>
              <th style={thRight}>Cycles proved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.addr}>
                <td style={td}>{r.label}</td>
                <td style={{ ...td, fontFamily: "monospace" }}>{r.addr}</td>
                <td style={tdNum}>{r.orders_taken.toLocaleString()}</td>
                <td style={tdNum}>
                  {Math.round(r.cycles_proved).toString().slice(0, 4)}
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: 16 }}>
        <summary>View stored snapshots (local)</summary>
        <pre style={pre}>
          {(() => {
            try {
              return JSON.stringify(
                JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"),
                null,
                2
              );
            } catch {
              return "[]";
            }
          })()}
        </pre>
      </details>
    </div>
  );
}

const th = {
  textAlign: "left",
  borderBottom: "1px solid #ddd",
  padding: "8px 10px",
  fontWeight: 600,
};
const thRight = { ...th, textAlign: "right" };
const td = {
  borderBottom: "1px solid #eee",
  padding: "8px 10px",
};
const tdNum = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const pre = {
  background: "#f7f7f9",
  border: "1px solid #ececec",
  borderRadius: 6,
  padding: 12,
  maxHeight: 260,
  overflow: "auto",
  fontSize: 12,
};
