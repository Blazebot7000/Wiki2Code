/**
 * Local demo seed: gives a connected repository a fake wiki clone plus two
 * highlights so the workspace UI can be exercised without touching GitHub.
 *
 * Usage: node --experimental-strip-types tools/seed-demo.mjs <dataDir>
 * The data dir must already contain a connected repo (github-svc.json).
 * It rewrites review-svc.json and gateway.json, so use a scratch data dir.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseBlocks } from '../libs/markdown/src/lib/markdown.ts';

const target = process.argv[2] ?? process.env.WIKI2CODE_DATA_DIR;
if (!target) {
  console.error(
    'Pass the data directory to seed, for example:\n' +
      '  node --experimental-strip-types tools/seed-demo.mjs "%APPDATA%\\Wiki2Code"',
  );
  process.exit(1);
}
const dataDir = resolve(target);
const repoId = 'Blazebot7000__mocafi-interview-demo';

const home = `# MoCaFi Interview Demo

A small Angular application that lists users and lets you filter them.

## Getting started

Run \`npm install\` and then \`npm start\` to launch the app on port 4200.

## Features

- Browse the list of users
- Filter users by name
- Open a user profile page

## Data source

The user list is loaded from a local JSON fixture in \`src/app/store/users\`.
`;

const features = `# Features

## User list

Every user is shown with an avatar, a name, and an email address.

## Search

Type into the search box to filter users by name.
`;

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function writeWikiRepo(wikiDir, pages) {
  rmSync(wikiDir, { recursive: true, force: true });
  mkdirSync(wikiDir, { recursive: true });
  for (const [name, markdown] of Object.entries(pages)) {
    writeFileSync(join(wikiDir, `${name}.md`), markdown, 'utf8');
  }
  git(wikiDir, ['init', '-q']);
  git(wikiDir, ['config', 'user.email', 'demo@wiki2code.local']);
  git(wikiDir, ['config', 'user.name', 'Wiki2Code Demo']);
  git(wikiDir, ['add', '.']);
  git(wikiDir, ['commit', '-q', '-m', 'docs: seed demo wiki']);
  return git(wikiDir, ['rev-parse', 'HEAD']);
}

function readJson(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

const wikiDir = join(dataDir, 'repos', repoId, 'wiki');
const wikiSha = writeWikiRepo(wikiDir, { Home: home, Features: features });

const githubPath = join(dataDir, 'github-svc.json');
const github = readJson(githubPath, { repos: [] });
const repo = (github.repos ?? []).find((item) => item.repoId === repoId);
if (!repo) {
  console.error(`Connect ${repoId} before seeding (no entry in ${githubPath}).`);
  process.exit(1);
}
repo.wikiReady = true;
repo.wikiError = undefined;
repo.wikiPageCount = 2;
repo.lastWikiSha = wikiSha;
repo.lastSyncedAt = new Date().toISOString();
writeJson(githubPath, github);

const blocks = parseBlocks(home);
const paragraph = blocks.find((block) => block.type === 'paragraph');
const list = blocks.find((block) => block.type === 'list');
const now = new Date().toISOString();

const highlights = [
  {
    id: 'hl_demo_search',
    repoId,
    pageSlug: 'Home',
    pageTitle: 'MoCaFi Interview Demo',
    blockId: paragraph?.id ?? '3:00000000',
    lineStart: paragraph?.lineStart ?? 3,
    lineEnd: paragraph?.lineEnd ?? 3,
    quote: paragraph?.text ?? '',
    severity: 'error',
    status: 'open',
    title: 'Search filters by email, not name',
    explanation:
      'The wiki says users are filtered by name, but `user-profile.store.ts` matches the query against the email address.',
    codeRefs: [
      {
        path: 'src/app/store/users/user-profile.store.ts',
        startLine: 24,
        endLine: 31,
        note: 'filter predicate compares email',
      },
    ],
    wikiSuggestion: 'Filter users by email address',
    codePlan: '',
    model: 'demo-model',
    commitSha: repo.lastCodeSha ?? '',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'hl_demo_avatar',
    repoId,
    pageSlug: 'Home',
    pageTitle: 'MoCaFi Interview Demo',
    blockId: list?.id ?? '13:00000000',
    lineStart: list?.lineStart ?? 13,
    lineEnd: list?.lineEnd ?? 16,
    quote: list?.text ?? '',
    severity: 'warning',
    status: 'open',
    title: 'Avatars are not rendered in the list',
    explanation:
      'The feature list promises avatars, but the list template only renders the name and email.',
    codeRefs: [
      {
        path: 'src/app/components/page/page.component.html',
        startLine: 1,
        endLine: 40,
        note: 'no avatar element',
      },
    ],
    wikiSuggestion: '',
    codePlan: '',
    model: 'demo-model',
    commitSha: repo.lastCodeSha ?? '',
    createdAt: now,
    updatedAt: now,
  },
];

writeJson(join(dataDir, 'review-svc.json'), {
  highlights,
  jobs: [],
  version: 1,
});

writeJson(join(dataDir, 'gateway.json'), {
  completed: true,
  activeRepoId: repoId,
});

console.log(`Seeded ${dataDir}`);
console.log(`  wiki: ${wikiDir} @ ${wikiSha.slice(0, 7)}`);
console.log(`  highlights: ${highlights.map((item) => item.id).join(', ')}`);
console.log(`  block ids: ${paragraph?.id}, ${list?.id}`);
