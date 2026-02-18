// @ts-nocheck
import type { PageServerLoad } from './$types';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

interface Harness {
  name: string;
  path: string;
  exists: boolean;
  preview?: string;
}

const HARNESS_CONFIGS = [
  {
    name: 'Claude Code',
    path: join(homedir(), '.claude', 'CLAUDE.md')
  },
  {
    name: 'OpenCode',
    path: join(homedir(), '.config', 'opencode', 'AGENTS.md')
  },
  {
    name: 'OpenClaw (Source)',
    path: join(homedir(), '.agents', 'AGENTS.md')
  }
];

export const load = async () => {
  const harnesses: Harness[] = [];
  
  for (const config of HARNESS_CONFIGS) {
    let exists = false;
    let preview = '';
    
    try {
      await stat(config.path);
      exists = true;
      
      const content = await readFile(config.path, 'utf-8');
      // Get first 500 chars as preview
      preview = content.slice(0, 500) + (content.length > 500 ? '\n...' : '');
    } catch {
      // File doesn't exist
    }
    
    harnesses.push({
      name: config.name,
      path: config.path,
      exists,
      preview
    });
  }
  
  return { harnesses };
};
;null as any as PageServerLoad;