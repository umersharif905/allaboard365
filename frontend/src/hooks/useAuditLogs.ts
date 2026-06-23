import { useState } from "react";
export function useAuditLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const fetchLogs = async () => { setLoading(true); setLoading(false); };
  return { logs, loading, fetchLogs };
}
