// Small text showing how much time is left before session (re-login) is required.
// Decodes refresh token JWT exp and shows countdown. Used on Member/Agent/TenantAdmin Settings.

import React, { useEffect, useState } from 'react';

function getExpFromRefreshToken(): number | null {
  try {
    const token = localStorage.getItem('refreshToken');
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    const exp = payload.exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

function formatTimeLeft(expSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const left = expSeconds - now;
  if (left <= 0) return 'Session expired';
  const hours = Math.floor(left / 3600);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `Session expires in ${days} day${days !== 1 ? 's' : ''}`;
  if (hours >= 1) return `Session expires in ${hours} hour${hours !== 1 ? 's' : ''}`;
  const mins = Math.floor(left / 60);
  return `Session expires in ${mins} minute${mins !== 1 ? 's' : ''}`;
}

export default function SessionExpiryText() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const update = () => {
      const exp = getExpFromRefreshToken();
      if (exp == null) {
        setText(null);
        return;
      }
      setText(formatTimeLeft(exp));
    };
    update();
    const interval = setInterval(update, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (!text) return null;

  return (
    <p className="text-xs text-gray-500 mt-6 pt-4 border-t border-gray-100">
      {text}
    </p>
  );
}
