import http from 'node:http';
import { configFromEnv, createGateway } from './server';

// Entry for the model-gateway container (bundled to dist/model-gateway.mjs by apps/agent-runner/build.mjs).
const config = configFromEnv();
const host = process.env.RYDE_GATEWAY_HOST ?? '127.0.0.1', port = Number(process.env.RYDE_GATEWAY_PORT ?? 8787);
const server = http.createServer(createGateway(config));
server.requestTimeout = 60000; // bounds receiving each request body; replies may run longer (upstream timeout)
server.listen(port, host, () => console.log(JSON.stringify({ at: new Date().toISOString(), ready: true, host, port, models: [...config.models] })));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close(() => process.exit(0)));
