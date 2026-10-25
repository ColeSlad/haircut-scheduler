import { createServer } from 'vite';
import { spawn } from 'node:child_process';
const port = Number(process.env.PORT || 3000);
const backendPort = port + 1;
const backend = spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', 'server/index.js'], {
  stdio: 'inherit', env: { ...process.env, PORT: String(backendPort), APP_ORIGIN: `http://localhost:${port}` },
});
const frontend = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${backendPort}`, '/uploads': `http://127.0.0.1:${backendPort}` } } });
try { await frontend.listen(); frontend.printUrls(); }
catch (error) { backend.kill(); throw error; }
const close = async () => { backend.kill(); await frontend.close(); process.exit(); };
process.on('SIGINT', close); process.on('SIGTERM', close);
