import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DESK_COMMANDS } from '../src/live/desk-client.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/desk-contract.json', import.meta.url), 'utf8'));
const sourcePath = fileURLToPath(new URL('../src/live/desk-client.ts', import.meta.url));
// Inspect the actual copied property types, not a second hand-maintained list that can drift too.
const serverFiles = ['status', 'updates', 'types'].map(name => fileURLToPath(new URL(`../../screen/server/desk/${name}.ts`, import.meta.url)));
const program = ts.createProgram([sourcePath, ...serverFiles], { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16, skipLibCheck: true });
const checker = program.getTypeChecker();
const source = program.getSourceFile(sourcePath)!;
function values(name: string, path: string[]): Array<string | null> {
  const declaration = source.statements.find(s => ts.isInterfaceDeclaration(s) && s.name.text === name);
  if (!declaration) throw new Error(`Missing copied voice interface ${name}`);
  let type = checker.getTypeAtLocation(declaration);
  for (const property of path) {
    type = checker.getNonNullableType(type);
    const symbol = type.getProperty(property);
    if (!symbol) throw new Error(`Missing voice property ${name}.${path.join('.')}`);
    type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  }
  return literals(type, `${name}.${path.join('.')}`);
}
function literals(type: ts.Type, label: string): Array<string | null> {
  const members = type.isUnion() ? type.types : [type];
  return members.filter(t => !(t.flags & ts.TypeFlags.Undefined)).map(t => {
    if (t.isStringLiteral()) return t.value;
    if (t.flags & ts.TypeFlags.Null) return null;
    throw new Error(`Voice ${label} must be an explicit literal union, got ${checker.typeToString(t)}`);
  });
}
const sorted = (values: Array<string | null>) => values.map(v => v === null ? '<null>' : v).sort();
const guidance = 'Update voice-contract.ts, regenerate the fixture, and update the copied voice union and handling.';
function matches(actual: Array<string | null>, expected: Array<string | null>) {
  for (const value of new Set([...actual, ...expected])) {
    expect(actual.includes(value) === expected.includes(value), `New desk state \`${value}\`: add it to voice-contract.ts as knock, when asked, or silent. ${guidance}`).toBe(true);
  }
  expect(sorted(actual), guidance).toEqual(sorted(expected));
}

describe('voice copies the desk contract', () => {
  it.each([
    ['pills', 'DeskItemSummary', ['status', 'pill']],
    ['live', 'DeskItemSummary', ['status', 'live']],
    ['kinds', 'CatchupWalkFocus', ['line', 'kind']],
  ] as const)('%s union matches the server fixture', (list, name, path) => {
    matches(values(name, [...path]), fixture[list]);
  });
  it('rejects a stale fixture even before it is regenerated', () => {
    for (const [file, alias, list] of [
      ['status', 'Pill', 'pills'], ['status', 'Live', 'live'],
      ['status', 'WaitingReason', 'waitingReasons'], ['updates', 'UpdateKind', 'kinds'],
      ['types', 'CommandType', 'commands'],
    ]) {
      const server = program.getSourceFile(serverFiles.find(path => path.endsWith(`/${file}.ts`))!)!;
      const declaration = server.statements.find(s => ts.isTypeAliasDeclaration(s) && s.name.text === alias);
      expect(declaration, `Missing server union ${alias}`).toBeDefined();
      const actual = literals(checker.getTypeAtLocation(declaration!), alias!);
      matches(actual, fixture[list!]);
    }
  });
  it('supports exactly the declared voice commands', () => {
    expect([...DESK_COMMANDS].sort(), guidance).toEqual([...fixture.voiceCommands].sort());
    for (const command of fixture.commands) {
      expect(fixture.policies.commands[command], guidance).toBeDefined();
      if (!(DESK_COMMANDS as readonly string[]).includes(command)) expect(fixture.policies.commands[command].policy).toBe('silent');
    }
  });
});
