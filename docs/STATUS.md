# Closer · 状态板

> **唯一进度事实源。** 开工先读这里，不要读别的文档来猜进度；收工必须回来改。
>
> 规则：`CONSTITUTION.md` 决定对错，`docs/decisions.md` 决定选哪个，`docs/design-v0.1.md` 决定长什么样，`docs/tech-spec.md` 决定怎么做。**本文只回答一个问题：现在走到哪了。**

## 当前阶段

**M4 真机回归 · 待做**（M0 契约、M1 判断器、M2 视图层、M3 面板与动作 均已完成）

| 验收 | 结果 |
|---|---|
| `npm run verify` | ✅ 通过（6 个 manifest 引用、3 项权限、全部文件语法、判断器 19/19） |
| `npm run smoke` | ✅ 12/12（真浏览器：开、背板不透、面板开合、缩放、关、DOM 还原、两种不该打开的图） |
| content 侧体积 | ⚠️ **37.5 KB / 40 KB**（只剩 2.5 KB 余量） |

## 模块状态

| 模块 | 文件 | 状态 | 证据 |
|---|---|---|---|
| 判断器 `judge()` | `src/content/detect.js` | ✅ | `test-judge` 19/19 |
| 让位检测 | `src/content/yield.js` | ✅ 代码 / ⚠️ 真机未验 | E2 有数字，真实站点未跑 |
| 命名空间 / 偏好 / 暂停列表 | `src/content/core.js` | ✅ | — |
| 尺寸比例格式 | `src/content/meta.js` | ✅ | 面板显示 600 × 400（e4） |
| 字节通道 | `src/content/bytes.js` + `src/background.js` | ✅ 代码 / ⚠️ 未接通真图 | 桩环境下走「缺失」分支 |
| 视图层 overlay | `src/content/overlay.js` | ✅ | e4：开、transform 生效、背板淡入、Esc 后 host 摘除、DOM 逐字节一致 |
| 复制 / 保存 | `src/content/actions.js` | ✅ 代码 / ⚠️ 未验剪贴板 | 需真机 + 真扩展上下文 |
| popup | `ui/popup.html` + `popup.js` | ✅ | 授权、按站点暂停、背景三选一 |
| welcome | `ui/welcome.html` + `welcome.js` | ✅ | 授权说明、暂停列表增删 |
| 图标 16/32/48/128 | `icons/` + `tools/icons.py` | ✅ | 241 B – 1.7 KB，`python3 tools/icons.py` 可重生 |
| 实验 E1–E4 | `tools/lab/` | ⚠️ E2/E3/E4 存在，E1 缺 | 均需 CDP，未接入 CI |

## 任务队列

| # | 任务 | 完成定义 | 状态 |
|---|---|---|---|
| T1 | 图标 + popup | `verify` 通过 | ✅ |
| T2 | welcome + 可选授权链路（D6） | 未授权不拦截，授权后生效，popup 可撤销 | ✅ 代码完成，真机待验 |
| T3 | overlay：Shadow DOM、FLIP、加载态 | 点开、Esc 关、关后 DOM 逐字节一致 | ✅ e4 通过 |
| T4 | 缩放 / 平移 / 双击 / `0` | 坐标数学按 tech-spec §3，边界不越界 | ✅ 滚轮已验，拖拽与键盘待验 |
| T5 | 信息面板（尺寸 + 体积 + Pause） | 体积取自 SW，面板可开合 | ✅ 尺寸已验，体积待真图 |
| T6 | 复制 / 保存 | 复制可粘贴；保存不申请 `downloads` | ✅ 代码完成，剪贴板待验 |
| T7 | 让位检测真机回归 | E2 漏开率有数字；E3 全过 | ⬜ 未做 |
| T8 | 性能预算实测（宪法第六条） | CPU 4× 降速下 `judge()` < 1ms、首帧 < 100ms | ⬜ 未做 |
| T9 | **体积回收** | content 侧回到 35 KB 以下，为图集漫游（O2）留余量 | ⬜ 新增，见 B4 |

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
| B2 | E2/E3/E4 需要 CDP 端口，未纳入 `verify` | 让位与视图质量靠手动跑 | 作者决定是否接 CI |
| B3 | 隐私政策页（申请 all-urls 前必须有） | 上架前置 | 延后 |
| B4 | content 侧 37.5/40 KB，仅剩 2.5 KB | 再加功能就撞宪法第六条 | 下一轮做 T9 |

## 本轮修掉的 bug（都留下了断言）

| bug | 怎么发现的 | 断言 |
|---|---|---|
| 背板透明，页面原图透出来 | 截图看出来的；`.dark .backdrop` 在 shadow 内匹配不到 host 上的类，要写 `:host(.dark)` | e4「背板不透明」 |
| 退场动画期间重新打开，`teardown()` 会把新 overlay 拆掉 | 读代码 | — |
| `ms(1)` 误当 reduced-motion 判据 | 读代码 | — |
