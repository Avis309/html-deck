'use strict';
// Runs a module of the bundled Python package with the first Python >= 3.11 found on PATH.
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PY_HOME = path.join(__dirname, '..', 'python');
const CANDIDATES = process.platform === 'win32'
  ? [['py', ['-3']], ['python', []], ['python3', []]]
  : [['python3', []], ['python', []]];
const VERSION_OK = 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)';

function findPython() {
  for (const [cmd, pre] of CANDIDATES) {
    if (spawnSync(cmd, [...pre, '-c', VERSION_OK], { stdio: 'ignore' }).status === 0) return [cmd, pre];
  }
  return null;
}

function run(moduleName) {
  const python = findPython();
  if (!python) {
    console.error('htmldeck: cần Python >= 3.11 — cài từ https://www.python.org/downloads/ hoặc chạy: uv python install 3.12');
    process.exit(127);
  }
  const [cmd, pre] = python;
  // The bundled copy goes first, ahead of site-packages; -P keeps the current folder off sys.path.
  const env = { ...process.env, PYTHONPATH: [PY_HOME, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  const child = spawn(cmd, [...pre, '-P', '-m', moduleName, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('error', (err) => {
    console.error(`htmldeck: không chạy được ${cmd}: ${err.message}`);
    process.exit(127);
  });
  // Ctrl-C already reaches the child through the terminal; only stay alive until it exits.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

module.exports = { run };
