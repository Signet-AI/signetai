#!/usr/bin/env node
/**
 * Signet CLI
 * Own your agent. Bring it anywhere.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { Signet } from '@signet/core';

const program = new Command();

program
  .name('signet')
  .description('Portable AI agent identity')
  .version('0.1.0');

// signet init
program
  .command('init')
  .description('Initialize a new Signet agent')
  .argument('[name]', 'Agent name', 'My Agent')
  .option('-p, --path <path>', 'Base path for agent files')
  .action(async (name, options) => {
    const spinner = ora('Initializing Signet...').start();
    
    try {
      const signet = new Signet({ basePath: options.path });
      const agent = await signet.init(name);
      
      spinner.succeed(chalk.green('Signet initialized!'));
      console.log();
      console.log(`  Agent: ${chalk.bold(agent.manifest.agent.name)}`);
      console.log(`  Path:  ${chalk.dim(signet.getDefaultPath?.() || '~/.signet')}`);
      console.log();
      console.log(chalk.dim('  Files created:'));
      console.log(chalk.dim('    agent.yaml  - Agent manifest'));
      console.log(chalk.dim('    soul.md     - Personality & behavior'));
      console.log(chalk.dim('    memory.md   - Core knowledge'));
      console.log(chalk.dim('    agent.db    - Structured memory'));
      console.log();
    } catch (err) {
      spinner.fail(chalk.red('Failed to initialize'));
      console.error(err);
      process.exit(1);
    }
  });

// signet status
program
  .command('status')
  .description('Show agent status')
  .option('-p, --path <path>', 'Base path for agent files')
  .action(async (options) => {
    try {
      const signet = new Signet({ basePath: options.path });
      
      if (!Signet.detect(options.path)) {
        console.log(chalk.yellow('No Signet agent found.'));
        console.log(`Run ${chalk.bold('signet init')} to create one.`);
        return;
      }
      
      const agent = await signet.load();
      const db = signet.getDatabase();
      
      console.log();
      console.log(chalk.bold('Signet Agent'));
      console.log();
      console.log(`  Name:     ${agent.manifest.agent.name}`);
      console.log(`  Created:  ${agent.manifest.agent.created}`);
      console.log(`  Updated:  ${agent.manifest.agent.updated}`);
      
      if (db) {
        const memories = db.getMemories();
        console.log(`  Memories: ${memories.length}`);
      }
      
      console.log();
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

// signet migrate
program
  .command('migrate')
  .description('Import data from another platform')
  .requiredOption('--from <source>', 'Source platform (chatgpt, claude, gemini)')
  .argument('<input>', 'Path to export file/directory')
  .action(async (input, options) => {
    const spinner = ora(`Migrating from ${options.from}...`).start();
    
    try {
      const { migrate } = await import('@signet/core');
      await migrate({ source: options.from, inputPath: input });
      
      spinner.succeed(chalk.green('Migration complete!'));
    } catch (err) {
      spinner.fail(chalk.red('Migration failed'));
      console.error(err);
      process.exit(1);
    }
  });

// signet search
program
  .command('search')
  .description('Search agent memories')
  .argument('<query>', 'Search query')
  .option('-n, --limit <n>', 'Maximum results', '10')
  .option('-p, --path <path>', 'Base path for agent files')
  .action(async (query, options) => {
    try {
      const signet = new Signet({ basePath: options.path });
      
      if (!Signet.detect(options.path)) {
        console.log(chalk.yellow('No Signet agent found.'));
        return;
      }
      
      await signet.load();
      const db = signet.getDatabase();
      
      if (!db) {
        console.log(chalk.yellow('No database found.'));
        return;
      }
      
      const { search } = await import('@signet/core');
      const results = await search(db, { 
        query, 
        limit: parseInt(options.limit) 
      });
      
      if (results.length === 0) {
        console.log(chalk.dim('No results found.'));
        return;
      }
      
      console.log();
      for (const r of results) {
        console.log(`  ${chalk.green('●')} ${r.content.slice(0, 80)}...`);
        console.log(chalk.dim(`    type: ${r.type} | score: ${r.score.toFixed(2)}`));
        console.log();
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

program.parse();
