#!/usr/bin/env node
// dsh-plugin-screen-recorder — graba la pantalla con ffmpeg gdigrab.
// Tools: status, record, list.

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const VERSION = '0.1.0';
const DSH_HOME = (() => {
  const v = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  return v || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
})();
const CONFIG_FILE = path.join(DSH_HOME, 'screen-recorder', 'config.json');
const CACHE_DIR = path.join(DSH_HOME, 'cache', 'screen-recorder');
const AUDIT_FILE = path.join(CACHE_DIR, 'audit.jsonl');
const READ_ONLY = String(process.env.DSH_SCREEN_MODE || '').toLowerCase() === 'read-only';
const MAX_SECONDS = 300;
const log = (m) => process.stderr.write(`[screen] ${m}\n`);

function loadConfig() {
  const defaults = { allowedPaths: [process.env.USERPROFILE || os.homedir()], outDir: CACHE_DIR, ffmpegPath: '', fps: 15 };
  try { if (existsSync(CONFIG_FILE)) return { ...defaults, ...(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}) }; } catch (e) { log(`config: ${e.message}`); }
  return defaults;
}
function audit(entry) { try { mkdirSync(CACHE_DIR, { recursive: true }); appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* best effort */ } }
function detectFfmpeg(config) {
  if (process.env.DSH_SCREEN_FFMPEG && existsSync(process.env.DSH_SCREEN_FFMPEG)) return process.env.DSH_SCREEN_FFMPEG;
  return config.ffmpegPath && existsSync(config.ffmpegPath) ? config.ffmpegPath : 'ffmpeg';
}
function ensureAllowed(config, abs) {
  const lower = path.resolve(abs).toLowerCase();
  const ok = (config.allowedPaths || []).some((root) => {
    const r = path.resolve(root).toLowerCase();
    return lower === r || lower.startsWith(r + path.sep);
  });
  if (!ok) throw new Error(`ruta no permitida: ${abs}. allowedPaths: ${(config.allowedPaths || []).join(', ')}`);
  return path.resolve(abs);
}
function run(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let settled = false;
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch { /* ignora */ } reject(new Error(`${path.basename(executable)} agotó el tiempo`)); } }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`no se pudo ejecutar ${executable}: ${error.message}`)); } });
    child.on('close', (code) => { if (settled) return; settled = true; clearTimeout(timer); if (code !== 0) reject(new Error(`${path.basename(executable)} terminó con código ${code}: ${(stderr || stdout).trim().slice(-700)}`)); else resolve({ stdout, stderr }); });
  });
}
function uniquePath(target) { if (!existsSync(target)) return target; const ext = path.extname(target); const base = target.slice(0, -ext.length); for (let i = 1; i < 1000; i++) { const c = `${base}-${i}${ext}`; if (!existsSync(c)) return c; } return target; }
const starts = [];
function checkRate() {
  const now = Date.now();
  while (starts.length && now - starts[0] > 60_000) starts.shift();
  if (starts.length >= 3) throw new Error('límite de grabaciones (3/minuto)');
  starts.push(now);
}
function textResult(t) { return { content: [{ type: 'text', text: t }] }; }

function buildInstructions() {
  return [
    'Screen Recorder: graba la pantalla con ffmpeg (gdigrab) para WENDIGO.',
    '',
    `Salida: ${loadConfig().outDir}`,
    '',
    'Herramientas: status, record, list.',
    '',
    'Reglas:',
    '- record requiere confirm:true y pedido explícito del usuario.',
    '- Respeta allowedPaths para el archivo de salida; nunca sobrescribe.',
    '- Duración máxima: ' + MAX_SECONDS + ' s. Avisa si se graba información sensible.',
    '- No graba audio en esta versión.',
  ].join('\n');
}

function buildServer() {
  const server = new McpServer({ name: 'dsh-plugin-screen-recorder', version: VERSION }, { capabilities: { tools: {} }, instructions: buildInstructions() });

  server.registerTool(
    'status',
    { title: 'Estado', description: 'ffmpeg detectado, salida, límites y modo.', inputSchema: z.object({}) },
    async () => {
      const config = loadConfig();
      const lines = [`Modo: ${READ_ONLY ? 'read-only' : 'normal'}`, `ffmpeg: ${detectFfmpeg(config)}`, `Salida: ${config.outDir || CACHE_DIR}`, `FPS por defecto: ${config.fps}`, `Duración máxima: ${MAX_SECONDS} s`, `Rutas permitidas: ${(config.allowedPaths || []).join(', ')}`];
      try { const { stdout } = await run(detectFfmpeg(config), ['-version'], 15_000); lines.push(`Versión: ${stdout.split(/\r?\n/)[0]}`); } catch (error) { lines.push(`Versión: ERROR — ${error.message}`); }
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'record',
    {
      title: 'Grabar pantalla',
      description: 'Graba la pantalla completa (o una región) durante N segundos. Requiere confirm:true.',
      inputSchema: z.object({
        seconds: z.number().int().min(1).max(MAX_SECONDS),
        fps: z.number().int().min(5).max(60).optional(),
        region: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(16), height: z.number().int().min(16) }).optional(),
        output: z.string().min(3).optional(),
        confirm: z.boolean().optional(),
      }),
    },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: record deshabilitado');
      if (args.confirm !== true) throw new Error('record requiere confirm:true y confirmación explícita');
      checkRate();
      const config = loadConfig();
      const outDir = path.resolve(config.outDir || CACHE_DIR);
      mkdirSync(outDir, { recursive: true });
      const target = args.output ? uniquePath(ensureAllowed(config, args.output)) : uniquePath(path.join(outDir, `grabacion-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`));
      mkdirSync(path.dirname(target), { recursive: true });
      const fps = args.fps ?? config.fps ?? 15;
      const ffArgs = ['-y', '-f', 'gdigrab', '-framerate', String(fps)];
      if (args.region) ffArgs.push('-offset_x', String(args.region.x), '-offset_y', String(args.region.y), '-video_size', `${args.region.width}x${args.region.height}`);
      ffArgs.push('-i', 'desktop', '-t', String(args.seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', target);
      await run(detectFfmpeg(config), ffArgs, (args.seconds + 60) * 1000);
      const size = statSync(target).size;
      audit({ tool: 'record', seconds: args.seconds, fps, output: path.basename(target), bytes: size, ok: true });
      return textResult(`Grabación: ${target} (${(size / 1024 / 1024).toFixed(1)} MB · ${args.seconds}s @ ${fps}fps${args.region ? ' · región' : ''}).`);
    },
  );

  server.registerTool(
    'list',
    { title: 'Listar grabaciones', description: 'Lista las grabaciones guardadas con tamaño y fecha.', inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }) },
    async (args) => {
      const config = loadConfig();
      const dir = path.resolve(config.outDir || CACHE_DIR);
      let files = [];
      try { files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.mp4')).map((name) => { const full = path.join(dir, name); const stat = statSync(full); return { name, size: stat.size, mtime: stat.mtime }; }).sort((a, b) => b.mtime - a.mtime).slice(0, args.limit ?? 20); } catch { /* sin carpeta */ }
      if (files.length === 0) return textResult(`Sin grabaciones en ${dir}.`);
      return textResult(files.map((file) => `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB · ${file.mtime.toISOString()}`).join('\n'));
    },
  );

  return server;
}

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ allowedPaths: [process.env.USERPROFILE || ''], outDir: CACHE_DIR, ffmpegPath: '', fps: 15 }, null, 2) + '\n', 'utf8');
  }
} catch (e) { log(`init: ${e.message}`); }
log(`modo ${READ_ONLY ? 'read-only' : 'normal'} · config: ${CONFIG_FILE}`);
serveStdio(buildServer, { onerror: (e) => log(`serveStdio: ${e.message}`) });
process.on('uncaughtException', (e) => log(`excepción: ${e.message}`));
process.on('unhandledRejection', (e) => log(`rechazo: ${e && e.message ? e.message : String(e)}`));
