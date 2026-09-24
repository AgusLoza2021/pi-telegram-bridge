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

  test('the Beginner plan never starts the connection and setup starts it at most once behind a guarded (y/N) offer', () => {
    const setup = read('scripts/setup.ps1');
    // The Beginner plan slice: from its marker line up to the post-enrollment
    // offers region. Adding the start script to the Beginner $componentScripts
    // array makes this fail.
    const beginnerPlanStart = setup.indexOf("Write-Host 'Finishing setup...'");
    const offersStart = setup.indexOf('# --- post-enrollment offers', beginnerPlanStart);
    assert.ok(beginnerPlanStart >= 0 && offersStart > beginnerPlanStart,
      'the Beginner plan slice and the post-enrollment offers region must both exist');
    const beginnerPlan = setup.slice(beginnerPlanStart, offersStart);
    // Strongest honest textual ban: any split or partially quoted reference
    // still leaves the fragment 'start-broker' inside at least one literal
    // token (e.g. ('start-broker' + '-service.ps1')), so the ban is
    // case-insensitive on that fragment instead of the whole filename.
    // Residual evasion a textual guard cannot close: a split where no single
    // token contains 'start-broker' (e.g. ('start-br' + 'oker-service.ps1'))
    // or a name assembled from variables/format strings.
    assert.doesNotMatch(beginnerPlan, /start-broker/i,
      'the Beginner plan must not reference the start script by any fragment containing start-broker (a split literal must fail): the Beginner path can never start the connection');
    // Wherever setup.ps1 invokes the start script, that invocation must sit
    // after an explicit `-match '^[yY]'` answer test behind a `(y/N)` prompt,
    // never behind the old Enter-means-yes `-notmatch '^[nN]'` default.
    // Quote-agnostic exactly-once count: single quotes, double quotes, any
    // whitespace after -ScriptName, any casing. A second invocation in
    // another quoting style must fail this just like a duplicated single-
    // quoted one.
    const startCallMatches = [...setup.matchAll(/-ScriptName\s+(['"])start-broker-service\.ps1\1/gi)];
    assert.equal(startCallMatches.length, 1,
      'setup must invoke the start script exactly once, in any quoting style, inside the single guarded (y/N) offer');
    const startCall = startCallMatches[0].index;
    assert.match(setup, /Turn the connection on now \(it starts at sign-in until you run "telegram off"\)\? \(y\/N\)/,
      'the start offer prompt must name the sign-in behavior and default to No');
    const promptSuffix = setup.lastIndexOf('(y/N)', startCall);
    const yesTest = setup.lastIndexOf("-match '^[yY]'", startCall);
    assert.ok(promptSuffix >= 0 && promptSuffix < startCall, 'the start offer prompt must end in (y/N) before the start call');
    const legacyDefaultYes = setup.indexOf("-notmatch '^[nN]'", promptSuffix);
    assert.ok(legacyDefaultYes < 0 || legacyDefaultYes > startCall,
      'the old Enter-means-yes default must not sit between the start prompt and the start call');
    assert.ok(yesTest >= 0 && yesTest < startCall, 'the start call must follow an explicit yes answer test');
    assert.ok(promptSuffix < yesTest, 'the start offer prompt must end in (y/N) before the yes answer test');
    assert.doesNotMatch(setup, /Start the broker now\?/, 'the old unconditional start prompt must not survive in setup');
  });

  test('the start offer is live code, not a comment: the prompt and the default-No answer test must be real statement lines with no default-yes form between prompt and start call', () => {
    const setup = read('scripts/setup.ps1');
    const startCallMatches = [...setup.matchAll(/-ScriptName\s+(['"])start-broker-service\.ps1\1/gi)];
    assert.equal(startCallMatches.length, 1,
      'setup must invoke the start script exactly once, in any quoting style');
    const startCall = startCallMatches[0].index;
    // The live prompt must be a real statement line. A whole-file text search
    // is satisfied by a commented-out copy of the sentence, so anchor the
    // match to the start of the $startAnswer assignment itself: a commented
    // copy begins with '#' and cannot match.
    const promptStatement = /^[ \t]*\$startAnswer\s*=\s*Read-Host 'Turn the connection on now \(it starts at sign-in until you run "telegram off"\)\? \(y\/N\)'[ \t]*$/m.exec(setup);
    assert.ok(promptStatement,
      'the live prompt must be a real $startAnswer = Read-Host statement line ending in (y/N); a commented copy of the sentence does not count');
    // The answer test must be a real if statement line (block-opening brace
    // allowed on the same line), so a reworded live test such as
    // "-eq '' -or -match '^[yY]'" cannot masquerade as the default-No guard.
    const answerStatement = /^[ \t]*if \(\$startAnswer -match '\^\[yY\]'\)[ \t]*\{?[ \t]*$/m.exec(setup);
    assert.ok(answerStatement,
      'the answer test must be a real line-initial if ($startAnswer -match ^[yY]) statement so a bare Enter cannot start the broker');
    assert.ok(promptStatement.index < answerStatement.index && answerStatement.index < startCall,
      'the prompt statement must precede the default-No answer test, which must precede the single start call');
    // Between the prompt and the single start call, ban every default-yes
    // form: each of these keeps a bare Enter (or a non-y answer) starting the
    // broker while the screen still shows (y/N).
    const guardedSlice = setup.slice(promptStatement.index, startCall);
    for (const [pattern, label] of [
      [/-notmatch/i, "-notmatch (the Enter-means-yes default)"],
      [/-eq\s*(''|"")/, "-eq '' (the empty-answer-means-yes default)"],
      [/-or\b/, '-or (a combined yes-default condition)'],
      [/-and\b/, '-and (a combined condition)'],
      [/-notin\b/i, '-notin'],
      [/IsNullOrEmpty/i, 'IsNullOrEmpty (the empty-answer-means-yes default)'],
      [/\[string\]::/i, 'a [string]:: helper'],
      [/!\s*\(\s*\$startAnswer/, 'a negated $startAnswer condition'],
      [/if \(\$startAnswer -match '\^\[nN\]'\)/, "a positive -match '^[nN]' gate (its else branch would start on a bare Enter)"],
    ]) {
      assert.doesNotMatch(guardedSlice, pattern,
        `the guarded offer must not contain ${label} between the prompt and the start call`);
    }
  });

  test('the setup summary states the connection state and the enable/disable switch semantics', () => {
    const setup = read('scripts/setup.ps1');
    assert.match(setup, /The connection is OFF and nothing starts at sign-in\./,
      'the summary must tell the owner when the connection was left off');
    assert.match(setup, /The connection is ON and starts at sign-in until you run "telegram off"\./,
      'the summary must tell the owner when the start offer turned the connection on');
    assert.match(setup, /runs at sign-in only while enabled/,
      'the summary must state the conditional sign-in lifecycle');
    assert.match(setup, /"telegram on" enables and starts it, "telegram off" stops and disables it/,
      'the summary must state the enable/disable switch semantics');
  });

  test('the docs state the per-path connection lifecycle and no stale auto-start claim survives', () => {
    const advanced = read('docs/ADVANCED.md');
    assert.match(advanced,
      /registered \*\*disabled\*\* by whichever setup path registers it: the Beginner path never enables or starts it, and the advanced path only asks once at the end/,
      'ADVANCED must scope the disabled registration and the per-path start behavior');
    assert.match(advanced, /with No as the default/,
      'ADVANCED must state the advanced start offer default (No)');
    assert.match(advanced,
      /Nothing starts at a sign-in unless you turn it on: with `telegram on`, or by answering yes to that single setup question/,
      'ADVANCED must state that nothing starts at sign-in unless the owner turns it on');
    assert.match(advanced, /`telegram on`[^.]*enables and starts/,
      'ADVANCED must document telegram on as enable + start');
    assert.match(advanced, /`telegram off`[^.]*stops it and clears/,
      'ADVANCED must document telegram off as stop + disable');
    assert.match(advanced, /stays off across sign-ins and restarts/,
      'ADVANCED must keep the stays-off-across-restarts behavior');

    const architecture = read('docs/ARCHITECTURE.md');
    assert.match(architecture,
      /registered disabled initially: the Beginner path never enables or starts it, the advanced path asks once at the end \(default No\)/,
      'ARCHITECTURE must scope the task model per path (Beginner never, advanced asks once with default No)');
    assert.match(architecture,
      /once turned off with `telegram off`[^;]*sign-in stays off until the owner runs `telegram on` again/,
      'ARCHITECTURE must state the post-off sign-in behavior');

    const readme = read('README.md');
    const glossaryRow = readme.split('\n').find((line) => line.includes('**The background connection**'));
    assert.ok(glossaryRow, 'the README glossary must keep the background connection row');
    assert.match(glossaryRow, /beginner setup registers it DISABLED and leaves it off/,
      'the README glossary must scope the disabled-and-off promise to the beginner setup');
    assert.match(glossaryRow, /advanced setup asks once at the end.*with No as the default/,
      'the README glossary must state the advanced start offer and its No default');
    assert.match(glossaryRow, /nothing starts at a sign-in unless you turn it on/,
      'the README glossary must state that nothing starts at sign-in unless the owner turns it on');

    // Stale claims this fix removed must not survive in any of these files.
    for (const [document, text] of [
      ['README.md', readme],
      ['QUICKSTART.es.md', read('QUICKSTART.es.md')],
      ['docs/ADVANCED.md', advanced],
      ['docs/ARCHITECTURE.md', architecture],
    ]) {
      assert.doesNotMatch(text, /choose \*\*Yes\*\* to start now/,
        `${document} must not claim a Yes answer starts the connection now`);
      assert.doesNotMatch(text, /It then asks whether to start the connection now/,
        `${document} must not claim setup asks whether to start the connection now`);
      assert.doesNotMatch(text, /Start the broker now\?/,
        `${document} must not keep the old start prompt`);
      assert.doesNotMatch(text, /Setup turns it on in one of two ways/,
        `${document} must not keep the two-ways auto-start claim`);
    }
    assert.doesNotMatch(read('QUICKSTART.es.md'), /no arranca nada hasta que la prend\u00e9s con `telegram on`/,
      'QUICKSTART.es must not keep the old glossary auto-start claim');
  });

  test('the Spanish glossary row keeps the turn-on/turn-off semantics', () => {
    const quickstart = read('QUICKSTART.es.md');
    const glossaryRow = quickstart.split('\n').find((line) => line.includes('**La conexi\u00f3n de fondo**'));
    assert.ok(glossaryRow, 'the Spanish glossary must keep the background connection row');
    assert.match(glossaryRow, /`telegram on`[^.]*la habilita y la arranca/,
      'the Spanish row must document telegram on as enable + start');
    assert.match(glossaryRow, /`telegram off`[^.]*la detiene y la deshabilita/,
      'the Spanish row must document telegram off as stop + disable');
    assert.match(glossaryRow, /sigue apagada despu\u00e9s de reiniciar/,
      'the Spanish row must keep the restart behavior');
  });

  test('the README quick-start step 5 turns the connection on before sending the reader to /tg', () => {
    const readme = read('README.md');
    const step5 = readme.split('\n').find((line) => /^5\. /.test(line));
    assert.ok(step5, 'the README quick-start must keep a step 5');
    assert.match(step5, /run `telegram on` there, then open Pi, run `\/tg`/,
      'step 5 must sequence `telegram on` before opening Pi and /tg');
    assert.doesNotMatch(readme, /^5\. Open Pi, run `\/tg`, choose \*\*Connect\*\*/m,
      'the old bare step 5 (which never turned the connection on) must not survive');
  });

  test('the Spanish quick-start step 7 states the connection is left off and bans the auto-start claim', () => {
    const quickstart = read('QUICKSTART.es.md');
    const step7 = quickstart.split('\n').find((line) => /^7\. /.test(line));
    assert.ok(step7, 'the Spanish quick-start must keep a step 7');
    assert.match(step7, /pero \*\*la deja apagada\*\*/,
      'step 7 must state setup leaves the background connection off');
    assert.doesNotMatch(quickstart, /la inicia por ti/,
      'the old auto-start claim must not survive in the Spanish quick-start');
  });

  test('the advanced stage 4 states registration never enables the connection and bans the start-the-broker claim', () => {
    const advanced = read('docs/ADVANCED.md');
    const stage4 = advanced.split('\n').find((line) => /^4\. \*\*Offer local installation\.\*\*/.test(line));
    assert.ok(stage4, 'the advanced lifecycle must keep stage 4');
    assert.match(stage4, /registration never enables it, and setup asks once at the end whether to turn the connection on, with No as the default/,
      'stage 4 must state registration never enables the connection and the end-of-setup offer defaults to No');
    assert.doesNotMatch(advanced, /\(always registered disabled\), and start the broker/i,
      'the old start-the-broker claim must not survive in ADVANCED');
  });
});
