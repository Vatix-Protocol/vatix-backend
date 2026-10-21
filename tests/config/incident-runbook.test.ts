import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function extractComposeContainerNames(compose: string): Set<string> {
  const names = new Set<string>();
  const regex = /container_name:\s*(vatix-[a-z-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(compose)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function extractComposeServiceNames(compose: string): Set<string> {
  const names = new Set<string>();
  const lines = compose.split('\n');
  let inServices = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) {
      continue;
    }
    // A non-indented, non-empty line ends the services block.
    if (line.length > 0 && !/^\s/.test(line)) {
      inServices = false;
      continue;
    }
    // Service keys sit at exactly two spaces of indentation under `services:`.
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      names.add(match[1]);
    }
  }
  return names;
}

function extractRunbookContainerNames(runbook: string): Set<string> {
  const names = new Set<string>();
  const regex = /\bvatix-[a-z-]+\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(runbook)) !== null) {
    names.add(match[0]);
  }
  return names;
}

describe('incident runbook', () => {
  const runbook = readRepoFile('docs/runbooks/incident-runbook.md');
  const compose = readRepoFile('docker-compose.yml');
  const composeDocs = readRepoFile('docs/docker-compose.md');

  it('every container referenced in the runbook is defined in docker-compose.yml', () => {
    const containerNames = extractComposeContainerNames(compose);
    const serviceNames = extractComposeServiceNames(compose);
    const knownServices = [...serviceNames].sort();
    const referenced = extractRunbookContainerNames(runbook);

    const missing = [...referenced].filter(
      (name) => !containerNames.has(name) && !serviceNames.has(name),
    );

    expect(
      missing,
      `Runbook references containers not defined in docker-compose.yml. ` +
        `Known services: ${knownServices.join(', ')}`,
    ).toEqual([]);
  });

  it('every container name documented in docs/docker-compose.md is defined in docker-compose.yml', () => {
    const containerNames = extractComposeContainerNames(compose);
    const documented = extractRunbookContainerNames(composeDocs);

    const missing = [...documented].filter((name) => !containerNames.has(name));

    expect(missing).toEqual([]);
  });
});
