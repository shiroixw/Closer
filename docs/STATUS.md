# Closer · 状态板

> **唯一进度事实源。** 开工先读这里，不要读别的文档来猜进度；收工必须回来改。
>
> 规则：`CONSTITUTION.md` 决定对错，`docs/decisions.md` 决定选哪个，`docs/design-v0.1.md` 决定长什么样，`docs/tech-spec.md` 决定怎么做。**本文只回答一个问题：现在走到哪了。**

## 当前阶段

**M4 完成 · 待手工验收**（M0 契约、M1 判断器、M2 视图层、M3 面板与动作、M4 真机回归全部闭环）

代码写完了，68 项自动断言全绿。但自动化一直用「临时副本 + 声明式 host 权限」绕过真实授权，
所以 **`安装 → welcome → 点 Enable → 授权 → 动态注册` 这条链路一次都没被真人走通过**。
按 `docs/manual-check.md` 走一遍，才算真的可上架。

| 验收 | 结果 |
|---|---|
| `npm run verify` | ✅ 通过（6 个 manifest 引用、3 项权限、全部文件语法、判断器 19/19） |
| `npm run smoke` | ✅ 25/25（e4 桩测 13 + e6 让位真机 7 + e7 速度预算 5） |
| `npm run live` | ✅ 24/24（真扩展 + 真实网页，阮一峰周刊） |
| content 侧体积 | ✅ **37.7 KB / 60 KB**（D21 修正后余量 22.3 KB） |
| 速度（CPU 4×） | ✅ judge **0.004 ms** · 首帧 **16.9 ms** · 加载期 **1 个**监听 |

## 模块状态

| 模块 | 文件 | 状态 | 证据 |
|---|---|---|---|
| 判断器 `judge()` | `src/content/detect.js` | ✅ | `test-judge` 19/19 |
| 让位检测 | `src/content/yield.js` | ✅ 真机已验 | e6：plain 开、sync 让、late 自关，7/7 |
| 命名空间 / 偏好 / 暂停列表 | `src/content/core.js` | ✅ | — |
| 尺寸比例格式 | `src/content/meta.js` | ✅ | 面板显示 600 × 400（e4） |
| 字节通道 | `src/content/bytes.js` + `src/background.js` | ✅ 真图已通 | e5：面板显示 `WEBP · 58 KB` |
| 视图层 overlay | `src/content/overlay.js` | ✅ | e4：开、transform 生效、背板淡入、Esc 后 host 摘除、DOM 逐字节一致 |
| 复制 / 保存 | `src/content/actions.js` | ✅ 代码 / ⚠️ 剪贴板未验 | 需真人点（合成事件没有瞬时激活） |
| popup | `ui/popup.html` + `popup.js` | ✅ | 授权、按站点暂停、背景三选一 |
| welcome | `ui/welcome.html` + `welcome.js` | ✅ | 授权说明、暂停列表增删 |
| 图标 16/32/48/128 | `icons/` + `tools/icons.py` | ✅ | 241 B – 1.7 KB，`python3 tools/icons.py` 可重生 |
| 实验 E1–E6 | `tools/lab/` | ✅ E2/E3/E4/E5/E6 存在，E1 析出为 `tools/probe-yield.js` | 均需 CDP，未接入 CI |

## 任务队列

| # | 任务 | 完成定义 | 状态 |
|---|---|---|---|
| T1 | 图标 + popup | `verify` 通过 | ✅ |
| T2 | welcome + 可选授权链路（D6） | 未授权不拦截，授权后生效，popup 可撤销 | ✅ 代码完成，真机待验 |
| T3 | overlay：Shadow DOM、FLIP、加载态 | 点开、Esc 关、关后 DOM 逐字节一致 | ✅ e4 通过 |
| T4 | 缩放 / 平移 / 双击 / `0` | 坐标数学按 tech-spec §3，边界不越界 | ✅ 滚轮已验，拖拽与键盘待验 |
| T5 | 信息面板（尺寸 + 体积 + Pause） | 体积取自 SW，面板可开合 | ✅ 尺寸已验，体积待真图 |
| T6 | 复制 / 保存 | 复制可粘贴；保存不申请 `downloads` | ✅ 代码完成，剪贴板待验 |
| T7 | 让位检测真机回归 | 真扩展下 plain 开 / sync 让 / late 自关 | ✅ e6 7/7，并修掉 `covered()` 的盲区 |
| T8 | 性能预算实测（宪法第六条） | CPU 4× 降速下 `judge()` < 1ms、首帧 < 100ms | ✅ e7 5/5：0.004 ms / 16.9 ms / 1 个监听 |
| T9 | ~~体积回收~~ | 改为**预算本身**：40 → 60 KB（宪法第六条修正，见 D21） | ✅ 关闭。压缩实现省了 289 B；余下 6.95 KB 是注释，删它违反第五条 |

## 中断规则（这条最重要）

**允许停下来问的，只有三类：**

1. 不可逆操作（删数据、force push、公开仓库）
2. 对外可见（发版、商店上架、对外公告）
3. 要推翻 `docs/decisions.md` 里已锁定的决策

**其余一律自己决定并继续跑**：遇到台账没覆盖的细节，按 `CONSTITUTION.md` 的裁决顺序选默认值，在 `docs/decisions.md` 的「默认假设」里追加一行（写明依据），然后接着干。

## 收工协议

每轮结束前必须做两件事，缺一视为未完成：

1. 跑 `npm run verify`（有浏览器时再加 `npm run smoke`），把结果写进「当前阶段」那张表
2. 更新「模块状态」表里变化的行

## 阻塞 / 待议

| # | 事项 | 影响 | 谁来定 |
|---|---|---|---|
| B1 | ~~v0.1 代码未提交~~ | 已在 commit 中存档 | ✅ 已解决 |
| B2 | E2–E6 需要 CDP 端口，未纳入 `verify` | 让位与视图质量靠手动跑 | 作者决定是否接 CI |
| B3 | 隐私政策页（申请 all-urls 前必须有） | 上架前置 | 延后 |
| B4 | ~~content 侧余量不足~~ | 预算 40 → 60 KB 后余量 22.3 KB | ✅ 已解决（D21） |
| B5 | **手工验收未做**（`docs/manual-check.md` 12 条） | 授权链路、剪贴板、真实站点让位都只有代码，没有一次真人走通 | 作者，约五分钟 |

## 本轮修掉的 bug（都留下了断言）

| bug | 怎么发现的 | 断言 |
|---|---|---|
| 背板透明，页面原图透出来 | 截图看出来的；`.dark .backdrop` 在 shadow 内匹配不到 host 上的类，要写 `:host(.dark)` | e4「背板不透明」 |
| 退场动画期间重新打开，`teardown()` 会把新 overlay 拆掉 | 读代码 | — |
| **桩测试被真扩展「让位」骗了**：残留的 Closer 扩展会注入 e4 的 `127.0.0.1` 页面并抢先 open，主世界的桩脚本随后 `acted()` 判定「页面动过了」主动让位。结果页面只有一个 `#closer`（扩展的），width / transform / backdrop 全对，但主世界的 `isOpen()` 是 false。**让位检测本身是对的，它只是被测试环境骗了** | 给 `open()` 与 `isOpen()` 埋点，发现 `open()` 从未进入主世界 | e4「环境干净」；三个桩测试开头自动 `clean()`；`tools/lab/clean-extensions.mjs` |
| **临时扩展实例无限堆积**：e5/e6 每次 `mkdtemp` 一个新目录，unpacked 扩展的 id 由路径决定，于是每跑一次就永久多一个实例（堆到 8 个）。这些实例会往 `*://*/*` 注入，包括 e4 的 `127.0.0.1` 桩页面，同一次点击上两个实例抢活，让 e4 报出「overlay 没打开」这种完全误导的失败 | 浏览器截图里看到 8 个 Closer | e4「环境干净：页面上只有一个 overlay」；e5/e6 改用固定路径并在结束时卸载 |
| **迟到纠正永远不触发**：`covered()` 用 `elementFromPoint`，而 overlay 自己是 fixed + 最高 z-index，取到的永远是我们自己，站点在下面挂查看器完全看不见 | e6 的 `late` 场景（先开、800ms 后站点挂查看器、再等 1.5s 没关） | e6「L2 站点慢挂查看器后，我们自己关掉」 |
| `ms(1)` 误当 reduced-motion 判据 | 读代码 | — |
