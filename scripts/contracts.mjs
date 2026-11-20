import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

function readText(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function list(relativePath) {
  return readdirSync(join(ROOT, relativePath));
}

function check(id, name, run) {
  try {
    const detail = run();
    return { id, name, ok: true, detail: detail || 'OK' };
  } catch (error) {
    return { id, name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countPages() {
  return list('src/pages').filter((file) => file.endsWith('.tsx')).length;
}

function countFunctions() {
  return list('supabase/functions').filter((name) => name !== '_shared').length;
}

function countMigrations() {
  return list('supabase/migrations').filter((file) => /^\d{5}_.+\.sql$/.test(file)).length;
}

function countPermissions() {
  const source = readText('backend/src/constants/permissions.ts');
  const matches = source.match(/'[a-z][a-z_]*:[a-z_:*]+'/g) || [];
  return new Set(matches).size;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

export function runContracts() {
  const pages = countPages();
  const functions = countFunctions();
  const migrations = countMigrations();
  const permissions = countPermissions();
  const readme = readText('README.md');
  const currentState = readText('docs/CURRENT_STATE.md');

  const checks = [
    check('C-01', '迁移编号从 00001 起连续且无重复', () => {
      const files = list('supabase/migrations')
        .filter((file) => /^\d{5}_.+\.sql$/.test(file))
        .sort();
      const numbers = files.map((file) => Number(file.slice(0, 5)));
      assert(numbers.length === migrations, `迁移数量不一致：${numbers.length} vs ${migrations}`);
      numbers.forEach((value, index) => {
        assert(value === index + 1, `迁移编号不连续：期望 ${String(index + 1).padStart(5, '0')}，实际 ${String(value).padStart(5, '0')}`);
      });
      return `${migrations} 个迁移，00001~${String(numbers.at(-1)).padStart(5, '0')} 连续`;
    }),

    check('C-02', 'Edge Functions 每个目录都有 index.ts', () => {
      const names = list('supabase/functions').filter((name) => name !== '_shared');
      assert(names.length === functions, `函数数量不一致：${names.length} vs ${functions}`);
      const missing = names.filter((name) => !existsSync(join(ROOT, 'supabase/functions', name, 'index.ts')));
      assert(missing.length === 0, `缺少 index.ts：${missing.join(', ')}`);
      return `${functions} 个函数 + _shared`;
    }),

    check('C-03', 'MCP 工具契约完整且名称唯一', () => {
      const contract = JSON.parse(readText('mcp/tools.json'));
      assert(Array.isArray(contract.tools), 'tools.json 缺少 tools 数组');
      assert(contract.tools.length === 7, `工具数量应为 7，实际 ${contract.tools.length}`);
      const names = new Set();
      for (const tool of contract.tools) {
        assert(tool.name && tool.description && tool.inputSchema, `工具契约字段缺失：${tool.name || 'unknown'}`);
        assert(!names.has(tool.name), `工具名称重复：${tool.name}`);
        names.add(tool.name);
      }
      return `7 个工具：${[...names].join(' / ')}`;
    }),

    check('C-04', 'README 页面/函数/迁移口径与实测一致', () => {
      assert(readme.includes(`${pages} 个页面`), `README 未声明 ${pages} 个页面`);
      assert(readme.includes(`${functions} 个微服务`) || readme.includes(`${functions} 个 Edge Functions`), `README 未声明 ${functions} 个函数`);
      assert(readme.includes(`${migrations} 个`), `README 未声明 ${migrations} 个迁移`);
      for (const stale of ['26 个迁移', '23 个 Supabase Edge Functions', '17 个微服务函数']) {
        assert(!readme.includes(stale), `README 仍含旧口径：${stale}`);
      }
      return `页面 ${pages} / 函数 ${functions} / 迁移 ${migrations}`;
    }),

    check('C-05', 'CURRENT_STATE 口径与实测一致', () => {
      assert(currentState.includes(`${pages} 个页面文件`), `CURRENT_STATE 未声明 ${pages} 个页面文件`);
      assert(currentState.includes(`${functions} 个微服务函数`), `CURRENT_STATE 未声明 ${functions} 个微服务函数`);
      assert(currentState.includes(`${migrations} 个 SQL 迁移文件`), `CURRENT_STATE 未声明 ${migrations} 个 SQL 迁移文件`);
      return '口径一致';
    }),

    check('C-06', '后台权限码数量与 README 声明一致', () => {
      assert(permissions === 17, `权限码应为 17，实际 ${permissions}`);
      assert(readme.includes(`${permissions} 个权限点`), `README 未声明 ${permissions} 个权限点`);
      return `${permissions} 个权限码`;
    }),

    check('C-07', '无密钥文件被 Git 跟踪', () => {
      const tracked = trackedFiles().filter((file) => /(^|\/)key\.txt$/i.test(file));
      assert(tracked.length === 0, `仍被跟踪：${tracked.join(', ')}`);
      return 'OK：key.txt 已全部解除跟踪';
    }),

    check('C-08', '交付物与证据链文件齐备', () => {
      const required = [
        'LICENSE',
        'docs/doc/TEST_CASES.md',
        'docs/doc/system_architecture.svg',
        'docs/doc/agent_workflow.svg',
        'docs/codearts/README.md',
        'docs/codearts/01-使用总览.md',
        'docs/codearts/02-全流程证据.md',
        'docs/codearts/03-prompt-台账.md',
        'docs/codearts/04-调试排错记录.md',
        'docs/codearts/05-文档生成记录.md',
        'docs/codearts/06-AI参与模块地图.md',
        'docs/codearts/screenshots/README.md',
      ];
      const missing = required.filter((file) => !existsSync(join(ROOT, file)));
      assert(missing.length === 0, `缺少：${missing.join(', ')}`);
      return `${required.length} 个交付物齐备`;
    }),

    check('C-09', '.gitignore 拦截密钥文件', () => {
      const ignore = readText('.gitignore');
      assert(ignore.includes('key.txt'), '.gitignore 未包含 key.txt');
      assert(ignore.includes('.env'), '.gitignore 未包含 .env');
      return 'key.txt / .env 已拦截';
    }),
  ];

  return {
    checks,
    passed: checks.filter((item) => item.ok).length,
    failed: checks.filter((item) => !item.ok).length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runContracts();
  for (const item of result.checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id} ${item.name} — ${item.detail}`);
  }
  console.log(`\n契约自检：${result.passed} 通过 / ${result.failed} 失败`);
  process.exit(result.failed === 0 ? 0 : 1);
}