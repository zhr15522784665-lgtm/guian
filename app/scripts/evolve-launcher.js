/**
 * 「见岸自适应演示.cmd」的实际逻辑。理由同 launcher.js：中文只由 node 打印。
 */
const readline = require('readline');

const line = (s = '') => console.log(s);

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(String(a || '').trim());
    });
  });
}

async function main() {
  line('');
  line('  见岸·自适应 · 自进化演示台');
  line('  ' + '='.repeat(44));
  line('');
  const config = require('../server/config');
  if (!config.llm.apiKey) {
    line('  [提示] 还没配置模型密钥：演示台能打开，但只能查看已有结果，不能跑。');
    line('  想跑：关掉这个窗口，双击「设置模型密钥.cmd」。');
    line('');
  }
  line('  正在启动，浏览器会自动打开...');
  let started;
  try {
    started = await require('../evolve/server.js').start({ open: true });
  } catch (err) {
    line('');
    line('  [失败] 起不来：' + String((err && err.message) || err));
    await ask('  按回车关闭窗口。');
    process.exitCode = 1;
    return;
  }
  if (started.busy) {
    require('child_process').exec(`cmd /c start "" "${started.url}"`, () => {});
    await ask('  按回车关闭这个窗口（已有的那个可以继续用）。');
    return;
  }
  line('  关掉这个窗口 = 停止演示台。运行记录和策略库保存在 app\\data\\evolve 里。');
}

main().catch((err) => {
  console.log('  [异常] ' + String((err && err.message) || err));
  process.exitCode = 1;
});
