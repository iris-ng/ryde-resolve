import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const esbuild=createRequire(require.resolve('tsx'))('esbuild');
await esbuild.build({entryPoints:['apps/agent-runner/live-worker.ts'],bundle:true,platform:'node',target:'node24',format:'esm',outfile:'dist/live-worker.mjs',banner:{js:"import { createRequire as liveCreateRequire } from 'node:module'; const require = liveCreateRequire(import.meta.url);"},external:['pg-native']});
await esbuild.build({entryPoints:['apps/model-gateway/main.ts'],bundle:true,platform:'node',target:'node24',format:'esm',outfile:'dist/model-gateway.mjs'});
