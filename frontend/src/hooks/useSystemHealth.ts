import { useState } from "react";
export function useSystemHealth() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const checkHealth = async () => { setLoading(true); setLoading(false); };
  return { health, loading, checkHealth };
}
