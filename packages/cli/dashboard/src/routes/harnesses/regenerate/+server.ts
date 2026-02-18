import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const SCRIPTS_DIR = join(homedir(), '.agents', 'scripts');

export const POST: RequestHandler = async () => {
  return new Promise((resolve) => {
    const script = join(SCRIPTS_DIR, 'generate-harness-configs.py');
    
    const proc = spawn('python3', [script], {
      timeout: 10000,
      cwd: join(homedir(), '.agents')
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(json({ 
          success: true, 
          message: 'Configs regenerated successfully',
          output: stdout 
        }));
      } else {
        resolve(json({ 
          success: false, 
          error: stderr || `Script exited with code ${code}` 
        }, { status: 500 }));
      }
    });
    
    proc.on('error', (err) => {
      resolve(json({ 
        success: false, 
        error: err.message 
      }, { status: 500 }));
    });
  });
};
