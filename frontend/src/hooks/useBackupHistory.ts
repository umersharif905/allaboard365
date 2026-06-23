import { useState } from "react";
export function useBackupHistory() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const fetchHistory = async () => { setLoading(true); setLoading(false); };
  return { history, loading, fetchHistory };
}
