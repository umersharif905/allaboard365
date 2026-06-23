import { useState } from "react";
export function useTenantSettings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(false);
  const fetchSettings = async () => { setLoading(true); setLoading(false); };
  return { settings, loading, fetchSettings };
}
