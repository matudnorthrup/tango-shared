import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('Loom recovery invariants (Python standard library)', () => {
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', fileURLToPath(new URL('.', import.meta.url)), '-p', 'test_*.py', '-v'], { stdio: 'pipe' });
});
