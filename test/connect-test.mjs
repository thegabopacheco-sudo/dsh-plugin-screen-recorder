// Test end-to-end de screen-recorder: graba 2 s de pantalla con gdigrab y verifica.
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDir = path.resolve(import.meta.dirname, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(path.join(tmpDir, 'dsh-home', 'screen-recorder'), { recursive: true });
const outDir = path.join(tmpDir, 'grabaciones');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(tmpDir, 'dsh-home', 'screen-recorder', 'config.json'), JSON.stringify({ allowedPaths: [tmpDir], outDir, ffmpegPath: '', fps: 5 }, null, 2), 'utf8');

function makeClient(extraEnv = {}) {
  const entry = process.env.SCREEN_SERVER ? path.resolve(process.env.SCREEN_SERVER) : path.join(packageDir, 'server.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME || process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP, DSH_HOME: path.join(tmpDir, 'dsh-home'), ...extraEnv }, stderr: 'pipe' });
  transport.stderr?.on('data', (c) => process.stderr.write(`[server] ${c}`));
  const client = new Client({ name: 'screen-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  return client.connect(transport).then(() => ({ client, transport }));
}
const textOf = (r) => (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

const { client, transport } = await makeClient();
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log('--- status ---'); console.log(textOf(await client.callTool({ name: 'status', arguments: {} })).slice(0, 500));
const noConfirm = await client.callTool({ name: 'record', arguments: { seconds: 1 } });
console.log('record sin confirm isError:', noConfirm.isError === true);
const recorded = await client.callTool({ name: 'record', arguments: { seconds: 2, fps: 5, confirm: true } });
console.log('--- record ---'); console.log(textOf(recorded));
const file = (textOf(recorded).match(/Grabación: (.+?) \(/) || [])[1];
console.log('archivo existe:', Boolean(file) && existsSync(file));
if (file && existsSync(file)) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-of', 'json', file], { encoding: 'utf8' }));
  const stream = probe.streams[0];
  console.log('dimensiones:', stream.width, 'x', stream.height, '| duración:', stream.duration || '(sin campo)');
}
const outside = await client.callTool({ name: 'record', arguments: { seconds: 1, output: path.join(tmpDir, '..', 'x.mp4'), confirm: true } });
console.log('salida fuera isError:', outside.isError === true);
console.log('--- list ---'); console.log(textOf(await client.callTool({ name: 'list', arguments: {} })));
await client.close(); try { await transport.close?.(); } catch {}
const { client: roClient, transport: roTransport } = await makeClient({ DSH_SCREEN_MODE: 'read-only' });
const roRecord = await roClient.callTool({ name: 'record', arguments: { seconds: 1, confirm: true } });
console.log('read-only record isError:', roRecord.isError === true);
const roStatus = await roClient.callTool({ name: 'status', arguments: {} });
console.log('read-only status permitido:', roStatus.isError !== true);
await roClient.close(); try { await roTransport.close?.(); } catch {}
console.log('OK');
