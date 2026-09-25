/**
 * `db.js` 包装层的**契约**守卫。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────────
 * `db.js` 把底层的 SQLite 驱动包成 `{ raw, exec, prepare }`（见 db.js 的 `wrap()`），
 * 因为底层可能是 better-sqlite3，也可能是 `node:sqlite` 回退（`db.js` 的 `openDatabase()`）。
 * **包装层没有暴露的一律不能用**，用了就是 `TypeError`。
 *
 * 真实事故：`server/routes/materials.js` 的批量导入写了 `db.transaction(...)` ——
 * 那是 better-sqlite3 独有、包装层**没有**的方法。于是 `/api/materials/import`
 * **每次调用都必然 500**，报 "db.transaction is not a function"，
 * 还被 try/catch 包成了"导入失败"，看着像业务问题而不是代码坏了，因此长期没人发现。
 *
 * 两件事让这个 bug 特别难查，也正是本测试要钉住的：
 *   ① **没有"本地好线上坏"的落差**：better-sqlite3 与 node:sqlite **两套引擎都没有**
 *      这个方法，所以在哪都同样地坏，靠换环境验证发现不了。
 *   ② 它在 API 层表现成业务失败，日志里也不会有异常栈（被 catch 转成了 500 响应体）。
 *
 * ⇒ 用"源码扫描"而非"跑到才知道"来兜住这类错误：
 *   凡是调用包装层**没提供**的驱动方法，直接让测试失败，并提示"要么改用 SAVEPOINT，
 *   要么先把该方法补进 wrap()"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 包装层**明确不提供**的驱动方法。用了就一定挂。
 * 每一条都对应一个真实驱动上的、包装层没透出来的 API。
 */
const WRAPPER_GAPS = ['transaction', 'pragma', 'backup', 'serialize', 'unsafeMode', 'loadExtension'];

/** 去掉注释：源码里提到 `db.transaction()` 的**注释**（解释为什么不用它）不算违规。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 递归收集 server/ 下的 .js（排除 .bak-* 备份与 node_modules）。 */
async function collectSources(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (entry.name.includes('.bak-')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectSources(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('★ 包装层的契约：只提供 { raw, exec, prepare }，别的一律没有', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-contract-'));
  try {
    process.env.ADMIN_DB = join(dir, 'admin.db');
    // ⚠️ 必须先设 ADMIN_DB 再 import：DB_PATH 是**模块加载时**就定下来的。
    //    且 db 是 `export let`，必须"先 import 模块对象 → initDb() → 再读 m.db"，
    //    解构会快照到 null。
    const m = await import('../server/db.js');
    await m.initDb();
    const db = m.db;
    assert.ok(db, 'initDb 之后 db 必须有值');

    assert.deepEqual(Object.keys(db).sort(), ['exec', 'prepare', 'raw'],
      '包装层暴露的键变了 —— 若确实新增了能力，请同步本条与下面的扫描清单');
    for (const missing of WRAPPER_GAPS) {
      assert.equal(typeof db[missing], 'undefined',
        `包装层意外暴露了 db.${missing}；若是有意加的，请从 WRAPPER_GAPS 里移除并说明`);
    }
    // 底层驱动可能**有** transaction（better-sqlite3），这恰恰是陷阱所在：
    // `db.transaction` 取不到，但 `db.raw.transaction` 在本地能取到 —— 于是有人会误以为能用。
    assert.equal(typeof db.prepare('SELECT 1 AS one').get().one, 'number', '包装层仍是可用的');
  } finally {
    delete process.env.ADMIN_DB;
    await rm(dir, { recursive: true, force: true });
  }
});

test('★ 源码里不许调用包装层没提供的方法（materials.js 的 `db.transaction` 事故的防复发钉）', async () => {
  const files = await collectSources(join(ADMIN, 'server'));
  assert.ok(files.length > 20, `扫描到的源文件太少（${files.length}），可能路径错了`);

  const offenders = [];
  const patterns = WRAPPER_GAPS.map((name) => ({
    name,
    // `db.xxx(` —— 只匹配包装层变量名 db 上的调用
    re: new RegExp(`\\bdb\\.${name}\\s*\\(`),
  }));

  for (const file of files) {
    const code = stripComments(await readFile(file, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const { name, re } of patterns) {
        if (re.test(line)) {
          offenders.push(`${file.replace(ADMIN + '/', '')}:${i + 1}  db.${name}() —— ${line.trim().slice(0, 80)}`);
        }
      }
    });
  }

  assert.deepEqual(offenders, [],
    '包装层（db.js 的 wrap()）没有提供这些方法，调用它们必然是 TypeError（且很容易被 try/catch 伪装成业务失败）。\n'
    + '正确做法：改用手写 SAVEPOINT（见 generation-billing.js / submission-journal.js / routes/gateway.js）；\n'
    + '若确实必须用驱动专有能力，请先把它补进 wrap() 并同步本文件的 WRAPPER_GAPS。\n'
    + offenders.map((o) => '  ' + o).join('\n'));
});
