import { useEffect, useState } from "react";

export default function TopProvers() {
  const [provers, setProvers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const API_URL = "https://boundless.up.railway.app/sql/db?sql=%7B%22json%22%3A%7B%22sql%22%3A%22select+%5C%22orders%5C%22.%5C%22order_id%5C%22%2C+%5C%22orders%5C%22.%5C%22state%5C%22%2C+%5C%22orders%5C%22.%5C%22customer_addr%5C%22%2C+%5C%22orders%5C%22.%5C%22prover_addr%5C%22%2C+%5C%22orders%5C%22.%5C%22created_at%5C%22%2C+%5C%22orders%5C%22.%5C%22timestamp%5C%22%2C+%5C%22orders%5C%22.%5C%22chain%5C%22%2C+%5C%22orders%5C%22.%5C%22timeout%5C%22%2C+%5C%22orders%5C%22.%5C%22lockin_price%5C%22%2C+%5C%22orders%5C%22.%5C%22bidding_start%5C%22%2C+%5C%22orders%5C%22.%5C%22slashed%5C%22%2C+%5C%22orders%5C%22.%5C%22stake_recipient%5C%22%2C+%5C%22orders%5C%22.%5C%22source%5C%22%2C+%5C%22orders_executions%5C%22.%5C%22total_cycles%5C%22%2C+%5C%22orders_executions%5C%22.%5C%22error%5C%22+from+%5C%22orders%5C%22+left+join+%5C%22orders_executions%5C%22+on+%5C%22orders_executions%5C%22.%5C%22order_id%5C%22+%3D+%5C%22orders%5C%22.%5C%22order_id%5C%22+where+%5C%22orders%5C%22.%5C%22chain%5C%22+in+%28%241%29+order+by+%5C%22orders%5C%22.%5C%22timestamp%5C%22+desc+limit+%242%22%2C%22params%22%3A%5B%22base_mainnet%22%2C2500%5D%2C%22typings%22%3A%5B%22none%22%2C%22none%22%5D%7D%7D";

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(API_URL);
        if (!res.ok) throw new Error("Failed to fetch");
        const json = await res.json();

        // Response should have json.rows or json.data
        const rows = json.rows || json.data || [];
        const totals = {};

        // group by prover_addr
        rows.forEach((row) => {
          const addr = row.prover_addr || "unknown";
          const cycles = Number(row.total_cycles) || 0;
          totals[addr] = (totals[addr] || 0) + cycles;
        });

        const top = Object.entries(totals)
          .map(([addr, cycles]) => ({ addr, cycles }))
          .sort((a, b) => b.cycles - a.cycles)
          .slice(0, 5);

        setProvers(top);
      } catch (e) {
        console.error(e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const timer = setInterval(fetchData, 60000); // refresh every minute
    return () => clearInterval(timer);
  }, []);

  if (loading) return <p>Loading provers...</p>;
  if (error) return <p style={{ color: "red" }}>Error: {error}</p>;

  return (
    <div style={{ padding: 20 }}>
      <h2>Top 5 Provers by Total Cycles</h2>
      <ol>
        {provers.map((p, i) => (
          <li key={i}>
            <strong>{p.addr}</strong> — {p.cycles.toLocaleString()} cycles
          </li>
        ))}
      </ol>
    </div>
  );
}
