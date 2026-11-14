/**
 * 双击启动器的主逻辑。
 *
 * 为什么整段逻辑在 node 里，而不是写在 .cmd 里：
 * 批处理的中文不可靠。.bat 按控制台代码页解析，而 node 输出的永远是 UTF-8 字节，
 * 两边一旦不一致，连「归岸」两个字都会变成乱码（桌面上那个叫「褰掑哺」的文件夹
 * 就是这么来的）。更要紧的是，用户看到满屏乱码会直接判定「这东西坏了」。
 *
 * 所以 .cmd 只做一件事：把控制权交给这里。中文只由 node 打印，永远是对的。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const APP_DIR = path.join(__dirname, '..');
const CONFIG_FILE = path.join(APP_DIR, 'config.local.json');

const line = (s = '') => console.log(s);

/** 问一个问题，读一行。返回去掉首尾空白的小写答案。 */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim().toLowerCase());
    });
  });
}

/** 读本地配置。读不到就当没有——这里只关心有没有一把密钥。 */
function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

async function main() {
  line('');
  line('  归岸 · 三个朋友');
  line('  ' + '='.repeat(44));
  line('');

  const cfg = readConfig();
  const key = String(cfg.apiKey || '').trim();
  // 环境变量里配了也算配好，免得命令行用户被要求再配一次
  const hasKey = Boolean(key) || Boolean(process.env.DEEPSEEK_API_KEY);

  if (!hasKey) {
    line('  [提示] 还没配置模型密钥。');
    line('');
    line('  现在可以先用「演示模式」看看能不能跑通：回复内容是假的，');
    line('  只用来确认服务和界面正常，不代表真实对话质量。');
    line('');
    line('  想接真模型：关掉这个窗口，双击「设置模型密钥.cmd」。');
    line('');

    const a = await ask('  用演示模式启动吗？输入 Y 启动，输入 N 先去配密钥：');
    if (a !== 'y' && a !== 'yes' && a !== '是') {
      line('');
      line('  好的。先双击「设置模型密钥.cmd」，配好再回来双击这个。');
      line('');
      await ask('  按回车关闭窗口。');
      return;
    }
    process.env.LLM_MOCK = '1';
  }

  line('');
  line('  正在启动，浏览器会自动打开...');

  let started;
  try {
    // 同一个进程里起服务：不需要再拉一个 node，关窗口就一起停
    const { start } = require('../server/index.js');
    started = await start({ open: true });
  } catch (err) {
    line('');
    line('  [失败] 起不来：' + String((err && err.message) || err));
    line('');
    line('  可以把上面这段报错发给帮你部署的人。');
    line('');
    await ask('  按回车关闭窗口。');
    process.exitCode = 1;
    return;
  }

  if (started.busy) {
    // 端口被占用时 start() 已经把原因打印出来了，这里只负责别让窗口一闪而过
    line('  按回车关闭这个窗口（已有的那个可以继续用）。');
    await ask('');
    return;
  }

  // 服务在跑。Ctrl+C 或关闭窗口即结束。
  process.on('SIGINT', () => {
    line('');
    line('  已停止。聊天记录还在 app\\data 里。');
    process.exit(0);
  });
}

main().catch((err) => {
  console.log('');
  console.log('  [异常] ' + String((err && err.message) || err));
  process.exitCode = 1;
});
