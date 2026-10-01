const backend = new URL(process.env.RENDER_API_URL || 'https://configure-render-url.invalid');
if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
  throw new Error('RENDER_API_URL must be your HTTPS Render service origin.');
}
if (!process.env.RENDER_API_URL || !process.env.SAOS_AUTH_USER || !process.env.SAOS_AUTH_PASSWORD) {
  throw new Error('Set RENDER_API_URL, SAOS_AUTH_USER and SAOS_AUTH_PASSWORD in Vercel.');
}

export const config = {
  framework: 'vite',
  buildCommand: 'npm run build',
  outputDirectory: 'dist',
  rewrites: [
    { source: '/api/:path*', destination: `${backend.origin}/api/:path*` },
    { source: '/:path*', destination: '/index.html' },
  ],
};
