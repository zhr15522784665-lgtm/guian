/**
 * 把用户粘贴的密钥写进 config.local.json。
 *
 * 同样放在 node 里而不是 .cmd 里，理由和 launcher.js 一样：批处理的中文不可靠，
 * 而且 `set /p` 对外人来说不够明显——他不知道要在哪里粘贴。
 * node 的 readline 至少能明确告诉他「这里可以右键粘贴」。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const APP_DIR = path.join(__dirname, '..');
const FILE = path.join(APP_DIR, 'config.local.json');

const line = (s = '') => console.log(s);

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || ''));
    });
  });
}

async function main() {
  line('');
  line('  设置模型密钥');
  line('  ' + '='.repeat(44));
  line('');
  line('  需要一把 DeepSeek 的 API Key，形如 sk-xxxxxxxxxxxx。');
  line('  获取地址： https://platform.deepseek.com/api_keys');
  line('');
  line('  粘贴方法：在这一行点鼠标右键（或按 Ctrl+V），然后回车。');
  line('');

  const raw = await ask('  把密钥粘贴到这里，然后按回车：');
  const key = String(raw).trim().replace(/^["']|["']$/g, '').trim();

  if (!key) {
    line('');
    line('  没有输入内容，已取消。原配置没有被改动。');
    line('');
    await ask('  按回车关闭窗口。');
    return;
  }

  if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
    line('');
    line('  [注意] 这看起来不像 DeepSeek 的密钥（一般以 sk- 开头）。');
    line('         仍然会保存；如果对话报错，先回来检查这一项。');
  }

  // 读旧配置再合并，别把用户之前设的端口之类冲掉
  let current = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') current = parsed;
  } catch (e) {
    // 不存在或写坏了都当空配置
  }

  current.apiKey = key;

  try {
    fs.writeFileSync(FILE, JSON.stringify(current, null, 2) + '\n', 'utf8');
  } catch (e) {
    line('');
    line('  [失败] 写不进配置：' + String((e && e.message) || e));
    line('  检查一下这个文件夹是不是只读，或者被安全软件拦了。');
    line('');
    await ask('  按回车关闭窗口。');
    process.exitCode = 1;
    return;
  }

  const masked = key.length > 12 ? key.slice(0, 6) + '*'.repeat(8) + key.slice(-4) : '***';
  line('');
  line('  已保存到：' + FILE);
  line('  密钥：' + masked);
  line('  （只显示首尾几位，用来确认是不是你刚才那把）');
  line('');
  line('  下一步：关掉这个窗口，双击「启动归岸.cmd」。');
  line('');
  await ask('  按回车关闭窗口。');
}

main().catch((err) => {
  console.log('');
  console.log('  [异常] ' + String((err && err.message) || err));
  process.exitCode = 1;
});
