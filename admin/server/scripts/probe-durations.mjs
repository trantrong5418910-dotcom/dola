/**
 * 只读复测：对指定账号反复做「原生 N 秒能力探测」，看是**偶发抖动**还是**常态不可用**。
 * 只调生产探测函数，不建任务、不扣积分、不提交提示词。
 *
 * 判据用 diagnostic.phase（比文案可靠）：
 *   navigate=页面没打开 / entry=输入框已出现 / bootstrap / model / duration=逐步更靠后
 * ok=true 才代表"时长控件确认完成"，也就是生成预检会放行的条件。
 *
 * 用法: node probe-durations.mjs <seconds> <id1,id2,...> <attemptsPerAccount>
 */
const SECONDS = Number(process.argv[2]) || 10;
const IDS = String(process.argv[3] || '408,410,412').split(',').map(Number).filter(Boolean);
const ATTEMPTS = Number(process.argv[4]) || 2;

const { parseCookies, probeNativeVideoViaBrowser } = await import('../dola/provider.js');
const { proxyOf, proxyUrlOf } = await import('../dola/proxy.js');
const { classifyFailure } = await import('../dola/generation-analytics.js');
const { DatabaseSync } = await import('node:sqlite');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(HERE, '..', 'data', 'admin.db'));
const log = (o) => console.log(JSON.stringify(o));

const rows = [];
for (const id of IDS) {
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
  if (!acc) { log({ id, error: '账号不存在' }); continue; }
  for (let i = 1; i <= ATTEMPTS; i++) {
    const t0 = Date.now();
    let r = null;
    try {
      r = await probeNativeVideoViaBrowser(parseCookies(acc.cookie), {
        seconds: SECONDS, proxy: proxyOf(acc), proxyUrl: proxyUrlOf(acc), timeout: 100000, accountId: id,
      });
    } catch (e) {
      r = { threw: true, error: String(e?.message || e).slice(0, 200) };
    }
    const err = String(r?.error || '');
    const item = {
      account: id, label: acc.label, attempt: i, seconds: SECONDS,
      ok: r?.ok === true, state: r?.state ?? null, reason: r?.reason ?? null,
      pageLoaded: r?.pageLoaded ?? null, phase: r?.diagnostic?.phase ?? null,
      classifiedAs: err ? classifyFailure(err).code : null,
      error: err.slice(0, 150), elapsedSec: Math.round((Date.now() - t0) / 1000),
    };
    rows.push(item);
    log({ stage: 'probe', ...item });
  }
}

log({ stage: 'summary', seconds: SECONDS, attemptsTotal: rows.length,
  okCount: rows.filter((r) => r.ok).length,
  phasesSeen: [...new Set(rows.map((r) => r.phase))],
  perAccount: IDS.map((id) => {
    const mine = rows.filter((r) => r.account === id);
    return { account: id, ok: mine.filter((r) => r.ok).length, total: mine.length,
      phases: mine.map((r) => r.phase), reasons: mine.map((r) => r.reason) };
  }) });
process.exit(0);
