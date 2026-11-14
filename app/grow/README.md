# grow/ · 会成长的种子策略

`seeds.jsonl` 一行一条「用户亲手教的」策略（`created_by: user_taught`）。
服务启动或第一次用到某个伙伴时，没进过策略库的种子会自动生成一个新版本写进 `data/grow/<botId>/`。

**加一条种子 = 往 seeds.jsonl 末尾加一行**，字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| id | ✅ | 唯一，建议 `U-006` 这种，不能和已有重复 |
| bots | ✅ | `"all"` 或 `["health","growth","listener"]` 里的若干个 |
| rule | ✅ | 写进提示词的行为方向（8~140 字），会过 `evolve/frozen/safety.validateRule` 安全闸 |
| plain | ✅ | 「我在成长」页给用户看的大白话 |
| when | | 适用情境（≤20 字） |
| triggers | | 检索触发词，通用策略留空数组 |
| hours | | 只在某时段生效，如 `[22,5]` = 22 点到次日 5 点 |
| source_cases | ✅ | 来源编号（可追溯） |
| source_note | | 来源说明，展示给用户 |

种子不能改写已有版本：每次补种子都会生成新版本，旧版本可一键回退。

当前 `seeds.jsonl` 的 S1-S5（文件中的 `U-001` 至 `U-005`）都标为
`created_by: user_taught`，并覆盖三个 bot：不给 A/B 菜单、用户想聊时不主动收尾、
冷场时从自己的领域起话题、吐槽时先接住情绪，以及深夜用时间和环境轻轻带到休息。

## pending 候选

`pending.jsonl` 放还没有经过用户确认的候选策略。每行使用和 `seeds.jsonl` 相同的 JSON
字段（通常保留 `id`、`bots`、`rule`、`plain`、`when`、`triggers`、`source_cases`），
但候选不会自动写入任何 bot 的版本快照，也不会进入提示词。确认后再把它追加到
`seeds.jsonl`；加种子仍然只需追加一行 JSON。

## 阶段 2：反馈与离开信号

【事实】普通模型回复下提供「说到心里了 / 不太对」。服务端凭 cookie 身份、
必填 botId 和服务端生成的 turnId 找到原轮次，拒绝客户端自报的输入、回复或 uid。
每轮只收一次按钮反馈，历史回放保留已评价状态。

- `POST /api/grow/feedback {botId, turnId, kind: "good" | "miss"}`：也支持服务端历史数组中的 messageIndex。
- `POST /api/grow/leave {botId, sessionId?, reason?}`：reason 仅接受「太啰嗦 / 没听懂我 / 不是我要的」。
- `GET /api/grow?botId=…` 的 stats 提供 good、failures 及按 source / reason / signalType 分类的失败计数。

【事实】会话轮数由服务端维护：离开或间隔超过 30 分钟后开启新会话。
1–2 轮离开记 short_session；用户明确不满、明显变短、重复问法分别记 dismissive、
short_reply、repeated_question。后三者评价的是上一条模型回复。离开提示用各角色自己的问法，
仅在站内离开聊天时问一次，可直接关闭；关闭页面或切到后台用 beacon / keepalive 上报。
sessionStorage 只暂存 botId、会话标识和选项，供下次载入补报；服务端去重，
无原因的 beacon 之后可补一次选项，旧会话标识不能结束新会话。

【判断】这些信号是「可能没接住」的启发式线索，不是实际流失或回复质量的定论。
采用按会话计轮，放弃按全部历史消息计轮，避免老用户新一轮短聊漏记；
采用可跳过的站内提示，放弃关闭页面前拦截和追问，保证用户可以随时离开。
本阶段只收集样本，不生成、晋级或注入新策略。

【事实】同一 uid + bot 最近出现 risk/crisis 后，反馈按钮隐藏、两接口返回
`{ok: true, ignored: true, reason: "safety"}`，隐式信号也禁收。
禁收标记沿用安全标记的 14 天期限，当前未结束的风险会话始终禁收；反馈池另对未截断原文
执行既有 core.classify 作为兜底。危机固定协议及冻结区均未改动。

【事实】样本只写本机 `data/grow/<botId>/failures.jsonl` / `good.jsonl`，
各保留最近 300 条；仅含时间、随机样本编号、信号分类、输入前 300 字和回复前 500 字，
不含 uid、turnId、会话标识或完整历史，不向外部服务发送反馈。good 累计数另存 stats.json，
失败分类计数对应当前保留的样本。选择从服务端取原文并按字段白名单保存，
放弃信任客户端片段和保存整段对话，以免冒充轮次及扩大隐私数据。

测试：`node --test` 默认使用真实 HTTP。若沙箱禁止 listen，可补跑
`GUIAN_IN_PROCESS_HTTP=1 node --test --test-isolation=none`，此模式使用 Node 的
IncomingMessage / ServerResponse 执行相同路由和落盘断言，但不验证端口监听与网络传输。

## 阶段 1、3、4：策略、复盘与晋级

【事实】阶段 1 的用户亲手教策略保存在 `seeds.jsonl`，服务端按 botId 同步到各自的版本快照；深夜种子带有 `[22,5]` 时段限制。正常对话只检索当前伙伴的策略。risk/crisis 的固定协议路径在策略提供器读取前返回。

【事实】阶段 3 由 `POST /api/grow/review {botId}` 启动复盘。候选先过 `evolve/frozen/safety.validateRule`，再按固定判定规则逐条三次认证，并对候选组合做整库复检；未通过的候选不会加入 active 版本。复盘状态可由 `GET /api/grow?botId=…` 读取。

【事实】阶段 4 的 `POST /api/grow/rollback {botId}` 把 active 指回上一版本。about 页「我在成长」只显示 active 策略的人话说明、来源和版本记录，不展示原始规则或语气包。

接口一览：

- `GET /api/grow?botId=…`：当前版本、active 策略、pending 候选、统计和复盘状态。
- `POST /api/grow/feedback {botId, turnId, kind}`、`POST /api/grow/leave {botId, sessionId?, reason?}`：记录普通轮次的用户反馈。
- `POST /api/grow/review {botId}`：复盘并尝试认证晋级。
- `POST /api/grow/rollback {botId}`：回到上一版本。

以上按 bot 的接口都要求明确传入 botId；未知 botId 会报错。uid 仅取自服务端 cookie。

## 阶段 5：记忆互通（未完成）

【事实】阶段 5 尚未接入可用的普通记忆互通开关，也没有把共享记忆从存储读取后传入对话的完整链路。`prompt.js` 中的共享记忆渲染段只是预留能力，不能据此声称功能已上线。

【待验证】`safety-flag.js` 和 `run-turn.js` 留有安全标记的部分接线；跨伙伴标记的持久化、更新和真实服务端传递尚未完成端到端验证。安全标记按设计只共享级别和时间、不共享原话，并且不受未来普通记忆互通开关控制。危机固定协议仍由既有分诊路径处理。

当前测试：会成长 27 项（策略与时段 6、信号及反馈池 7、复盘与认证 7、前端反馈和成长页 7）。样例数据初始化测试另有 2 项。全项目最终测试数以根目录 `AGENTS.md` 和本轮 `node --test` 结果为准。
