import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

const TEXT_EXTENSIONS = new Set(['.cmd', '.json', '.md', '.mjs', '.ps1', '.ts', '.yml']);
function publicTextFiles(directory = ROOT) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    // Mirrors the "not shipped" entries in .gitignore. Local workflow notes are
    // not part of the public text candidate, so a path inside them must never be
    // able to fail this guard.
    if (['.git', '.local', '.atl', 'node_modules', 'odd'].includes(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...publicTextFiles(absolute));
    } else if (TEXT_EXTENSIONS.has(extname(entry)) || entry === '.gitignore' || entry === 'LICENSE') {
      files.push(absolute);
    }
  }
  return files;
}

const REQUIRED = [
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/workflows/ci.yml',
  '.github/pull_request_template.md',
  'docs/assets/banner.svg',
];

describe('public repository hygiene', () => {
  test('ships the required legal, security and contributor surfaces', () => {
    for (const relative of REQUIRED) {
      assert.equal(existsSync(join(ROOT, relative)), true, `${relative} must exist`);
    }
    assert.match(read('LICENSE'), /^MIT License\r?$/m);
    assert.equal(JSON.parse(read('package.json')).license, 'MIT');
    assert.match(read('README.md'), /\[MIT License\]\(LICENSE\)/);
    assert.match(read('README.md'), /\[SECURITY\.md\]\(SECURITY\.md\)/);
    assert.match(read('README.md'), /\[CONTRIBUTING\.md\]\(CONTRIBUTING\.md\)/);
    assert.match(read('.gitignore'), /^\.atl\/$/m, 'Pi-local runtime metadata must stay untracked');
  });

  test('security policy names the protected data and private reporting route', () => {
    const policy = read('SECURITY.md');
    assert.match(policy, /Report a vulnerability/);
    assert.match(policy, /Do not open a public issue/i);
    for (const boundary of [
      'outbound Telegram long polling',
      'exact enrolled Telegram user',
      'DPAPI CurrentUser',
      'explicit `/tg` opt-in',
      'never a generic shell',
      'finalized assistant text only',
    ]) {
      assert.ok(policy.includes(boundary), `missing security boundary: ${boundary}`);
    }
    for (const protectedItem of ['bot token', 'Telegram user or chat identifiers', 'credentials.bin', 'bridge.sqlite', 'raw logs']) {
      assert.ok(policy.includes(protectedItem), `missing protected item: ${protectedItem}`);
    }
  });

  test('contributor gate is pinned and excludes real-state commands from automation', () => {
    const guide = read('CONTRIBUTING.md');
    assert.match(guide, /npm ci --ignore-scripts --omit=dev --no-audit --no-fund/);
    assert.match(guide, /npm test/);
    assert.match(guide, /scripts\/test\.ps1/);
    assert.match(guide, /should \*\*not\*\* run setup, enrollment, service-install, service-start, or Telegram smoke scripts/);
    assert.match(guide, /Conventional Commit/);
  });

  test('public issue form asks for no secret-bearing attachment or raw diagnostic', () => {
    const form = read('.github/ISSUE_TEMPLATE/bug_report.yml');
    assert.match(form, /private vulnerability-reporting flow/);
    assert.match(form, /I removed bot tokens, Telegram IDs, QR\/pairing data/);
    assert.doesNotMatch(form, /label:\s*(logs?|attachments?|database|state files?)/i);
    assert.doesNotMatch(form, /upload|attach (?:a |the )?(?:file|screenshot|log)/i);
  });

  test('pull-request template makes security and verification review explicit', () => {
    const template = read('.github/pull_request_template.md');
    assert.match(template, /Exact Telegram user \+ private-chat authorization/);
    assert.match(template, /No remote shell/);
    assert.match(template, /npm test/);
    assert.match(template, /scripts\/test\.ps1/);
  });

  test('the complete public text candidate contains no parent-repository or real-user path', () => {
    const thisTest = join(ROOT, 'tests', 'public-repo-hygiene.test.mjs');
    const candidates = publicTextFiles().filter((file) => file !== thisTest);
    // `relative` returns backslashes on Windows, so a backslash path would slip
    // past a forward-slash literal. Normalize before scanning.
    const combined = candidates
      .map((file) => `${relative(ROOT, file).split(sep).join('/')}\n${readFileSync(file, 'utf8')}`)
      .join('\n');
    const legacyModulePath = ['tools', 'pi-telegram-bridge'].join('/');
    const internalTaskPath = ['odd', 'tasks'].join('/');
    assert.ok(!combined.toLowerCase().includes(legacyModulePath), 'legacy parent-module path leaked');
    assert.ok(!combined.toLowerCase().includes(internalTaskPath), 'internal task path leaked');
    assert.doesNotMatch(combined, /C:\\Users\\(?!you\b|me\b|x\b)|C:\/Users\/(?!you\b|me\b|x\b)/i);
  });

  test('code of conduct adopts the canonical text and routes reports privately', () => {
    const conduct = read('CODE_OF_CONDUCT.md');
    assert.match(conduct, /contributor-covenant\.org\/version\/2\/1\/code_of_conduct\//);
    assert.match(conduct, /\[SECURITY\.md\]\(SECURITY\.md\)/);
    assert.doesNotMatch(
      conduct,
      /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/,
      'a link-first code of conduct must not duplicate a contact address',
    );
    assert.match(read('README.md'), /\[Code of conduct\]\(CODE_OF_CONDUCT\.md\)/);
    assert.match(read('CONTRIBUTING.md'), /CODE_OF_CONDUCT\.md/);
  });

  test('the issue chooser keeps the private route and refuses blank issues', () => {
    const chooser = read('.github/ISSUE_TEMPLATE/config.yml');
    assert.match(chooser, /^blank_issues_enabled: false\r?$/m);
    assert.match(chooser, /security\/advisories\/new/);
    const form = read('.github/ISSUE_TEMPLATE/feature_request.yml');
    assert.match(form, /^name: Feature request\r?$/m);
    assert.match(form, /I read SECURITY\.md, and this request keeps every documented boundary intact\./);
    assert.doesNotMatch(form, /label:\s*(logs?|attachments?|database|state files?)/i);
    assert.doesNotMatch(form, /upload|attach (?:a |the )?(?:file|screenshot|log)/i);
  });

  test('CI runs the documented gates on the only supported platform', () => {
    const workflow = read('.github/workflows/ci.yml');
    assert.match(workflow, /^permissions:\r?\n  contents: read\r?$/m);
    assert.match(workflow, /runs-on: windows-latest/);
    assert.match(workflow, /node-version: "24"/);
    assert.match(workflow, /npm ci --ignore-scripts --omit=dev --no-audit --no-fund/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /scripts\/test\.ps1/);
    assert.doesNotMatch(workflow, /runs-on:\s*(?:ubuntu|macos)/, 'the project claims Windows only');
  });

  test('the front page leads with a repository-owned banner', () => {
    assert.match(read('README.md'), /!\[[^\]]+\]\(docs\/assets\/banner\.svg\)/);
    const banner = read('docs/assets/banner.svg');
    assert.match(banner, /<svg[^>]*viewBox="0 0 1280 280"/);
    assert.doesNotMatch(banner, /<script/i);
    assert.doesNotMatch(banner, /(?:href|src)="https?:/i, 'the banner must not depend on an external asset');
  });

  test('every published URL points at the real repository', () => {
    const repository = 'https://github.com/AgusLoza2021/pi-telegram-bridge';
    const manifest = JSON.parse(read('package.json'));
    assert.equal(manifest.repository.url, `git+${repository}.git`);
    assert.equal(manifest.homepage, repository);
    assert.equal(manifest.bugs.url, `${repository}/issues`);
    assert.equal(typeof manifest.author, 'string');
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length >= 8);
    assert.match(read('.github/ISSUE_TEMPLATE/config.yml'), new RegExp(repository.replace(/[/.]/g, '\\$&')));
    for (const document of ['README.md', 'QUICKSTART.es.md']) {
      const text = read(document);
      assert.ok(text.includes(`git clone ${repository}.git`), `${document} must show the real clone command`);
      assert.doesNotMatch(text, /repository-url/, `${document} must not keep a pre-publication placeholder`);
    }
  });

  test('the narrow Git approval exception is documented consistently across public docs', () => {
    // SECURITY.md: the exception stays narrow and the residual local trust
    // is stated, never hidden.
    const security = read('SECURITY.md');
    assert.match(security, /narrow exception: closed typed `\/commit` and `\/push` operations/);
    assert.match(security, /one-use approval card/);
    assert.match(security, /bound to a local repository snapshot/);
    assert.match(security, /staged-only commit with the fixed message/);
    assert.match(security, /no force, no tag expansion, and `--atomic`/);
    assert.match(security,
      /local Git hooks, configuration, remote URLs, and credential or transport helpers remain fully trusted/);
    assert.match(security, /uncertain Git outcome requires manual repository inspection before any retry/i);
    // G4 precision: the absolute "raw Git output never reaches Telegram"
    // claim is wrong — approval cards intentionally carry bounded
    // Git-derived metadata. Docs must state exactly what is excluded and
    // what is intentionally included.
    assert.doesNotMatch(security, /Raw Git output, URLs, and credentials never reach Telegram/,
      'the absolute raw-output claim is inaccurate: bounded snapshot metadata is intentional');
    assert.match(security,
      /Raw Git diff output, stderr and diagnostics, full remote URLs, credentials, and local paths never reach Telegram/,
      'the precise exclusion list must be stated');
    assert.match(security,
      /approval cards intentionally show only the bounded snapshot metadata \(staged shortstat, branch, upstream alias, HEAD SHA, fingerprint, and the push card's ahead count\)/i,
      'the intentional bounded metadata must be documented');
    assert.match(security, /fixed, mapped copy/i,
      'result cards must be documented as fixed mapped copy');

    // CONTRIBUTING.md: change rules must pin the exception's shape.
    const contributing = read('CONTRIBUTING.md');
    assert.match(contributing, /closed typed `\/commit` and `\/push`/);
    assert.match(contributing, /one-use, snapshot-bound approval/);
    assert.match(contributing, /staged-only commit with the fixed message/);
    assert.match(contributing, /no force, no tag expansion, and `--atomic`/);

    // README.md: the plain-words safety section states the exception.
    const readme = read('README.md');
    assert.match(readme, /one-use approval card/);
    assert.match(readme, /staged-only/);
    assert.match(readme, /fixed message/);
    assert.match(readme, /no force/);
    assert.match(readme, /local Git configuration, credentials, and hooks remain trusted/);
    assert.match(readme, /manual inspection before any retry/i);

    // The Spanish quickstart mirrors the exception in plain Spanish.
    const quickstart = read('QUICKSTART.es.md');
    assert.match(quickstart, /excepción acotada/i);
    assert.match(quickstart, /tarjeta de aprobación de un solo uso/i);
    assert.match(quickstart, /solo el índice ya preparado \(staged\)/i);
    assert.match(quickstart, /sin force/i);
    assert.match(quickstart, /siguen siendo de confianza/i);
    assert.match(quickstart, /revisá tu repositorio antes de volver a intentar/i);

    // ARCHITECTURE.md: the protocol section names the closed protocol.
    const architecture = read('docs/ARCHITECTURE.md');
    assert.match(architecture, /Git approval protocol/);
    assert.match(architecture, /snapshot drift/);
    assert.match(architecture, /`--atomic`/);
    assert.match(architecture, /whitelisted result codes/);
    assert.match(architecture, /hooks/);

    // G4 precision: lifecycle is conditional and the bounded-metadata
    // claim replaces the absolute raw-output claim.
    assert.doesNotMatch(architecture, /sign-in starts nothing until/i,
      'the task model must not claim sign-in never starts the broker: Beginner setup auto-starts it');
    assert.match(architecture,
      /registered disabled initially: Beginner setup enables and starts it automatically after ENROLL, advanced setup asks before enabling/i,
      'the task model must state the two setup paths conditionally');
    assert.match(architecture,
      /once turned off with `telegram off`[^;]*sign-in stays off until the owner runs `telegram on` again/i,
      'the post-off sign-in behavior must be stated');
    assert.doesNotMatch(architecture,
      /results reach Telegram as whitelisted result codes only[^.]*raw Git output, URLs, and credentials never do/i,
      'the absolute raw-output claim must not survive in ARCHITECTURE');
    assert.match(architecture,
      /raw Git diff output, stderr and diagnostics, full remote URLs, credentials, and local paths never (reach Telegram|do), and approval cards intentionally show only the bounded snapshot metadata/i,
      'the precise exclusion list must appear in ARCHITECTURE');
    assert.match(architecture,
      /approval cards intentionally show only the bounded snapshot metadata \(staged shortstat, branch, upstream alias, HEAD SHA, fingerprint, and the push card's ahead count\)/i,
      'the intentional bounded metadata must be documented in ARCHITECTURE');

    // ADVANCED.md and BEGINNER_UX.md carry the same precise claims.
    for (const [document, text] of [['docs/ADVANCED.md', read('docs/ADVANCED.md')], ['docs/BEGINNER_UX.md', read('docs/BEGINNER_UX.md')]]) {
      assert.doesNotMatch(text, /raw Git output never appears|Raw Git output, URLs, and credentials never appear/i,
        `${document} must drop the absolute raw-output claim`);
      assert.match(text,
        /Raw Git diff output, stderr and diagnostics, full remote URLs, credentials, and local paths never (reach|appear)/i,
        `${document} must state the precise exclusion list`);
      assert.match(text,
        /approval cards intentionally show only the bounded snapshot metadata \(staged shortstat, branch, upstream alias, HEAD SHA, fingerprint, and the push card's ahead count\)/i,
        `${document} must document the intentional bounded metadata`);
      assert.match(text, /fixed, mapped copy|closed, fixed result-code mapping/i,
        `${document} must document the fixed mapped result copy`);
    }

    // ADVANCED.md: the command table and result copy are documented.
    const advanced = read('docs/ADVANCED.md');
    assert.match(advanced, /`\/commit \[shortId\]`/);
    assert.match(advanced, /`\/push \[shortId\]`/);
    assert.match(advanced, /Commit approval ready/);
    assert.match(advanced, /Push approval ready/);
    assert.match(advanced, /Commit completed/);
    assert.match(advanced, /Push completed/);
    assert.match(advanced, /unknown Git outcome/i);
    assert.match(advanced, /inspect the repository/i);
    assert.match(advanced, /`--atomic`/);

    // BEGINNER_UX.md: the exact beginner result lines are contracted.
    const ux = read('docs/BEGINNER_UX.md');
    assert.match(ux, /Commit approval ready/);
    assert.match(ux, /Push approval ready/);
    assert.match(ux, /Commit completed/);
    assert.match(ux, /Push completed/);
    assert.match(ux, /git_unknown/);
  });

  test('the README glossary states the connection lifecycle accurately (G4)', () => {
    const readme = read('README.md');
    // The Beginner setup path starts the connection automatically at the
    // end of installation; the glossary must not contradict that with
    // "starts nothing until telegram on".
    assert.doesNotMatch(readme, /starts nothing until/i,
      'the glossary must not contradict the install-time auto-start');
    const glossaryRow = readme.split('\n').find((line) => line.includes('**The background connection**'));
    assert.ok(glossaryRow, 'the glossary must keep the background connection row');
    assert.match(glossaryRow, /setup (ends|finishes)|automatically.*install|install.*automatically/i,
      'the glossary must state the install-time auto-start');
    assert.match(glossaryRow, /`telegram on`/);
    assert.match(glossaryRow, /`telegram off`/);
    assert.match(glossaryRow, /restart/i,
      'the glossary must keep the restart behavior');
  });

  test('the connection lifecycle is documented accurately across docs and setup (G4)', () => {
    // Documented truth: the task is initially registered disabled; Beginner
    // setup auto-starts it after ENROLL; advanced setup asks; later
    // `telegram on`/`telegram off` control the enable bit; once off it
    // stays off across sign-ins until turned on again.
    const advanced = read('docs/ADVANCED.md');
    assert.doesNotMatch(advanced, /nothing runs at a sign-in until/i,
      'the lifecycle section must not claim the task never runs before telegram on');
    assert.match(advanced, /registered \*\*disabled\*\*/i,
      'the initial disabled registration must stay documented');
    assert.match(advanced, /Beginner setup.*automatically|automatically.*after ENROLL/i,
      'the Beginner auto-start path must be documented');
    assert.match(advanced, /Start the broker now\?/,
      'the advanced setup prompt must be documented');
    assert.match(advanced, /`telegram on`[^.]*enables and starts/i,
      'telegram on must be documented as enable + start');
    assert.match(advanced, /`telegram off`[^.]*stops it and clears/i,
      'telegram off must be documented as stop + disable');
    assert.match(advanced, /stays off across sign-ins and restarts/i,
      'the stays-off-across-restarts behavior must stay documented');

    const quickstart = read('QUICKSTART.es.md');
    assert.doesNotMatch(quickstart, /no arranca nada hasta que la prend/i,
      'the Spanish glossary must not contradict the install-time auto-start');
    assert.match(quickstart, /la arranca sola al terminar|arranca autom\u00e1ticamente/i,
      'the Spanish glossary must state the Beginner auto-start');
    assert.match(quickstart, /te pregunta si quer\u00e9s arrancarla/i,
      'the Spanish glossary must state the advanced prompt');
    assert.match(quickstart, /`telegram on`[^.]*habilita y arranca/i,
      'telegram on must be documented as enable + start in Spanish');
    assert.match(quickstart, /`telegram off`[^.]*la detiene y la deshabilita/i,
      'telegram off must be documented as stop + disable in Spanish');
    assert.match(quickstart, /sigue apagada despu\u00e9s de reiniciar/i,
      'the Spanish glossary must keep the restart behavior');

    const setup = read('scripts/setup.ps1');
    assert.doesNotMatch(setup, /nothing connects at sign-in/,
      'the advanced summary must not claim the task never runs at sign-in');
    assert.match(setup, /Start the broker now\?/,
      'the advanced prompt must exist in setup');
    assert.match(setup, /runs at sign-in only while enabled/i,
      'the conditional lifecycle wording must exist in the summary');
    assert.match(setup, /"telegram on" enables and starts it, "telegram off" stops and disables it/,
      'the enable/disable semantics must be stated in the summary');
    // Beginner auto-start: install + start run back-to-back, unprompted,
    // only in the -Beginner branch (the advanced path prompts between them).
    assert.match(setup, /'install-broker-service\.ps1',\s*'start-broker-service\.ps1'/,
      'the Beginner branch must install and start the broker without a prompt');
  });

  test('G4 doc precision: drift-vs-stale resolution, ahead count, per-operation snapshots, prompt condition (G4)', () => {
    // 1) BEGINNER_UX: drift uses the specific drift copy; expiry/restart/
    // consumed/replaced tokens use the stale-approval copy — one sentence
    // cannot claim all four use the stale line.
    const beginnerUx = read('docs/BEGINNER_UX.md');
    assert.doesNotMatch(beginnerUx,
      /drift, expiry, broker restart or a consumed token resolves with the stale line/i,
      'drift and stale are different resolutions and must not be conflated');
    assert.match(beginnerUx, /snapshot drift resolves with the drift copy/i,
      'drift must be documented as its own resolution');
    assert.match(beginnerUx,
      /expiry, broker restart, a consumed or replaced token resolve with the stale-approval copy/i,
      'the stale resolutions must be enumerated separately');

    // 2) All four docs must include the push card's ahead count in the
    // bounded-metadata enumeration, and must not keep the old list that
    // omits it.
    const enumerations = [
      ['SECURITY.md', read('SECURITY.md')],
      ['docs/ADVANCED.md', read('docs/ADVANCED.md')],
      ['docs/ARCHITECTURE.md', read('docs/ARCHITECTURE.md')],
      ['docs/BEGINNER_UX.md', read('docs/BEGINNER_UX.md')],
    ];
    for (const [document, text] of enumerations) {
      assert.match(text,
        /fingerprint, and the push card's ahead count\)/i,
        `${document} must include the push card ahead count in the bounded metadata`);
      assert.doesNotMatch(text,
        /bounded snapshot metadata \(staged shortstat, branch, upstream alias, HEAD SHA, fingerprint\)/i,
        `${document} must not keep the enumeration without the ahead count`);
      assert.doesNotMatch(text, /raw diff|full remote URL[^s]|credentials? (are|is) sent/i,
        `${document} must not suggest raw diff, paths, URLs or credentials are sent`);
    }

    // 3) SECURITY/ADVANCED must separate the commit and push snapshots and
    // must not keep the conflated single parenthetical.
    const security = read('SECURITY.md');
    const advanced = read('docs/ADVANCED.md');
    for (const [document, text] of [['SECURITY.md', security], ['docs/ADVANCED.md', advanced]]) {
      assert.doesNotMatch(text, /snapshot \(branch, upstream, HEAD, staged index\)/i,
        `${document} must not conflate commit and push snapshot contents`);
      assert.match(text,
        /commit snapshot binds the repository root, branch, HEAD, and the full staged-index listing/i,
        `${document} must state the commit snapshot binding`);
      assert.match(text,
        /push snapshot binds the repository root, branch, HEAD, and the configured remote\/upstream branch and ahead state \(never a resolved push URL or Git configuration beyond that\)/i,
        `${document} must state the push snapshot binding and its limits`);
    }

    // 4) ADVANCED: the start prompt is conditional on task registration.
    assert.match(advanced,
      /`Start the broker now\?`[^.]*only when you accepted registering the task earlier/i,
      'the advanced prompt must be documented as conditional on task registration');

    // 5) setup.ps1 header: the no-autostart claim is advanced-path-only;
    // the Beginner path starts after ENROLL.
    const setup = read('scripts/setup.ps1');
    assert.doesNotMatch(setup, /never autostarts anything by[\s\S]*?itself, and never sends/,
      'the header must not claim the script never autostarts anything: the Beginner path does');
    assert.match(setup, /The ADVANCED path never autostarts/,
      'the no-autostart claim must be scoped to the advanced path');
    assert.match(setup, /only offers the optional start prompt/,
      'the advanced start prompt must be described as optional');
    assert.match(setup, /Beginner path starts the broker automatically after ENROLL/,
      'the Beginner auto-start must be stated in the header');
  });
});
