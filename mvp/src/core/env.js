/** 极简 .env 加载器（不引 dotenv 依赖）。已存在的环境变量不会被覆盖。 */
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(file = '.env') {
  const candidates = [file, path.join(process.cwd(), file)];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    for (const line of fs.readFileSync(c, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, key, rawVal] = m;
      let val = rawVal.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    return c;
  }
  return null;
}
