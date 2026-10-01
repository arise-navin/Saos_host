const base = import.meta.env?.VITE_API_BASE_URL || (import.meta.env?.PROD ? 'https://saos-host.onrender.com/api' : '/api');

export const apiUrl = path => `${base.replace(/\/$/, '')}${path}`;
