// 日更流水线包装器：调用 Python 回填「标记日 · 当日跌停家数随时间」曲线
// 脚本本身是增量的：所有标记日都有曲线时立即退出，因此每天跑几乎没有成本。
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
execFileSync('python', ['fetch-dt-intraday.py'], {
  cwd: HERE,
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  timeout: 90 * 60 * 1000,
});
