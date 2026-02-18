import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const MEMORY_SCRIPT = join(homedir(), '.agents', 'memory', 'scripts', 'memory.py');

export const GET: RequestHandler = async ({ url }) => {
  const id = url.searchParams.get('id');
  if (!id) {
    return json({ error: 'id is required', results: [] }, { status: 400 });
  }

  const k = url.searchParams.get('k') ?? '10';
  const type = url.searchParams.get('type');

  const args = ['similar', id, '--json', '--k', k];
  if (type) args.push('--type', type);

  return new Promise<Response>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(json({ error: 'Timed out', results: [] }, { status: 504 }));
    }, 15000);

    const proc = spawn('python3', [MEMORY_SCRIPT, ...args]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error('memory.py similar error:', stderr);
        resolve(json({ error: 'Similarity search failed', results: [] }, { status: 500 }));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // memory.py may return { results: [...] } or just [...]
        const results = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
        resolve(json({ results }));
      } catch {
        resolve(json({ error: 'Invalid response from memory.py', results: [] }, { status: 500 }));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.error('Failed to spawn memory.py:', err);
      resolve(json({ error: 'Could not run similarity search', results: [] }, { status: 500 }));
    });
  });
};
