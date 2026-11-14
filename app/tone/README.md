# 三个伙伴的语气包

每个文件只服务同名 bot：`health.json` 是阿柚、`growth.json` 是小步、`listener.json` 是阿听。文件随代码发布，服务端按 botId 读取；缺少文件时记录日志并跳过该 bot，不会借用其他伙伴的内容。

## 格式与长度

JSON 包含 `bot_id`、`name`、`source`、`rules`、`examples`、`examples_note`、`injectable_chars` 和 `winning_condition`。提示词只渲染 `rules` 与 `examples`，格式固定为：

```text
规则：
1. <rule1>
2. <rule2>
样例：
用户：<user>
伙伴：<bot>
用户：<user>
伙伴：<bot>
```

规则和对白按文件顺序呈现，样例之间只有一个换行。渲染后的规则与样例最多 **1500 个 Unicode 字符**，包含换行和标点；统计方式等同于 JavaScript 的 `[...text].length`。提示词前面的「学语气、不要照抄、不能盖过边界和安全要求」说明句不计入上限。超过上限会拒绝加载，不会截断。

## 怎么改

直接编辑对应 JSON。保留 `bot_id` 与文件名一致；只把确认过的说话规则写入 `rules`，把用户认可的对白写入 `examples`。修改后运行 `cd app && node --test`。`injectable_chars` 是素材记录字段，运行时会按实际渲染内容重新计数。

## 来源与对比

【事实】本次盲评使用 deepseek-v4-flash，10 组对比中，「今晚规则 + 样例」平均 22.9，GitHub LCCC 口语语料平均 17.6，两者混合平均 21.0。因此当前语气包以今晚用户亲教的规则和认可对白为主。阿柚包里原有的两条风格填充已替换为当晚真实对白。
