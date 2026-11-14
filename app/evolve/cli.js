#!/usr/bin/env node
/**
 * 见岸·自适应 · 命令行。演示台之外的备用入口（也用于提前跑完第一次）。
 *
 *   node evolve/cli.js status
 *   node evolve/cli.js run [train|holdout]
 *   node evolve/cli.js learn
 *   node evolve/cli.js holdout
 *   node evolve/cli.js rollback [v0]
 *   node evolve/cli.js reset
 */

const config = require('../server/config');
const { createLab } = require('./lab');
const { defaultParams, createModelAdapter } = require('./model');

function fmt(m) {
  return `要点 ${m.pointsHit}/${m.pointsTotal} · 二次伤害 ${m.harmful} · 危机漏识别 ${m.crisisMiss}/${m.crisisTotal} · 未达标 ${m.failed}/${m.tasks} · tokens ${m.tokens} · 错误 ${m.errors}`;
}

async function main() {
  const [cmd = 'status', arg] = process.argv.slice(2);
  const params = defaultParams(config);
  const needModel = ['run', 'learn', 'holdout', 'iterate'].includes(cmd);
  if (needModel && !config.llm.apiKey) {
    console.error('没有模型密钥：设置 DEEPSEEK_API_KEY（或 LLM_API_KEY），或双击「设置模型密钥.cmd」。');
    process.exit(2);
  }
  const lab = createLab({
    dataDir: config.dataDir,
    callModel: needModel ? createModelAdapter(config, params) : async () => ({ text: '' }),
    params
  });

  if (cmd === 'status') {
    const s = lab.state();
    console.log(`模型 ${params.model} · 激活版本 ${s.active} · 策略 ${s.strategies.length} 条`);
    console.log('指纹', JSON.stringify(s.fingerprint.frozen), 'code', s.fingerprint.code, 'params', s.fingerprint.params);
    for (const r of s.runs) console.log(`${r.id}  ${fmt(r.metrics)}`);
    return;
  }
  if (cmd === 'run') {
    const out = await lab.run(arg || 'train');
    console.log(out.runId, fmt(out.metrics));
    return;
  }
  if (cmd === 'holdout') {
    const out = await lab.holdout();
    for (const id of Object.values(out)) console.log(id, fmt(lab.getRun(id).metrics));
    return;
  }
  if (cmd === 'learn') {
    const out = await lab.learn();
    console.log(`复盘 ${out.failures.length} 条失败，新增 ${out.accepted.length} 条，拒收 ${out.rejected.length} 条 → ${out.newVersion || '无新版本'}（${out.durationMs}ms）`);
    for (const s of out.accepted) console.log(`  + ${s.id} [${s.source_cases.join(',')}] ${s.rule}`);
    if (out.replaced && out.replaced.length) console.log(`  ~ 替换旧策略 ${out.replaced.join(', ')}`);
    for (const s of out.rejected) console.log(`  × ${s.reason}：${s.rule}`);
    return;
  }
  if (cmd === 'iterate') {
    const log = await lab.iterate({
      maxRounds: Math.max(1, Math.min(50, Number(arg) || 3)),
      onRound: (r) => console.log(`R${r.round} ${r.version} ← ${r.parent} ${r.promoted ? '晋级' : '未晋级（训练集变差）'} · 库 ${r.library} 条\n  训练 ${fmt(r.train)}\n  留出 ${fmt(r.holdout)}`)
    });
    console.log('最好版本', log.best);
    return;
  }
  if (cmd === 'rollback') {
    console.log('已激活', lab.rollback(arg || 'v0'));
    return;
  }
  if (cmd === 'reset') {
    lab.reset();
    console.log('进化数据已清空，回到 v0。');
    return;
  }
  console.error('未知命令', cmd);
  process.exit(1);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
