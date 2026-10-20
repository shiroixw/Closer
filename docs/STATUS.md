# Closer · 状态板

> **唯一进度事实源。** 开工先读这里，不要读别的文档来猜进度；收工必须回来改。
>
> 规则：`CONSTITUTION.md` 决定对错，`docs/decisions.md` 决定选哪个，`docs/design-v0.1.md` 决定长什么样，`docs/tech-spec.md` 决定怎么做。**本文只回答一个问题：现在走到哪了。**

## 当前阶段

**M4 完成 · 待手工验收**（M0 契约、M1 判断器、M2 视图层、M3 面板与动作、M4 真机回归全部闭环）

**2026-10-20 一轮优化**：视图层修三处（chrome 唤不回、顶栏吞点击、复制不可发现）、点击契约补上设计 §3.1 的三条放行规则、纯函数补测 31 条、E8 从「外网站点诊断」改成「自包含桩页面回归」。
**同日第二轮**：popup 授权后仍显示 Allow（`[hidden]` 被 `.row` 盖掉）、popup 换背板时已打开的图不跟着变（新增 E9）、窄窗口下大图偏右下并被裁（`margin:auto` 在溢出时不生效）、E5/E7/E8/E9 全部固定视口（点击类测试此前会因窗口大小假红）、E5 的还原判据从整页长度改为指向自身痕迹。
**同日第三轮（bad case）**：H5 活动页的整块可点卡片被接管 → 判断器新增 `cursor:pointer`（认声明边界，D24）与正方形小图（D25）两条，e6 加 card / square 用例；把「让位检测回答不了只改文字/class 的点击」这个盲区写进 design §4 与 §8。
**同日第四轮（发布前清账）**：`npm run verify` 在 Windows 上必然 ENOENT（`tools/` 把 `URL.pathname` 当路径，拼出 `D:\D:\…`）——两处已改回 `path.resolve`；`check-manifest` 新增「content 侧顶层声明撞名」检查，补上逐文件 `node --check` 结构上永远看不见的那类错误；`bytes` 的 meta 缓存不再钉住失败；复制大图加像素闸，超限降级为复制地址（D26）；shadow host 去掉 `aria-modal`（D27）。
**同日补机制**：新增 `docs/cases.md` 案例台账（含一条「静态无解、不修」的记录），宪法第二条加「检验二」——上一次误接管是什么形态、为什么不在台账里。缺的不是规则，是发现机制。
**同日第五轮（i18n）**：中英两种语言落地。用浏览器内置的 `_locales` + `chrome.i18n`（零依赖、零检测逻辑、不进 content 预算），manifest 的 name/description 也跟着切；新增 `tools/check-i18n.mjs` 进 `verify`。这一步推翻 D8，按第十条把代价写进 D28，宪法「非目标」与 design §10 同步改写。
**同日第六轮（中文露出的布局债）**：真机截图发现「暂停」竖排成两个字——长站点名是不可断开的 token，flex 项的 `min-width:auto` 让它拒绝变窄，把按钮压到一字宽。文案换成中文才露出来（英文没有断行点，只会溢出）。修在 `ui.css` 的组件层，e9 加两条几何断言。

代码写完了，131 项自动断言全绿。但自动化一直用「临时副本 + 声明式 host 权限」绕过真实授权，
所以 **`安装 → welcome → 点 Enable → 授权 → 动态注册` 这条链路一次都没被真人走通过**。
按 `docs/manual-check.md` 走一遍（16 条），才算真的可上架。

| 验收 | 结果 |
|---|---|
| `npm run verify` | ✅ 通过（6 个 manifest 引用、3 项权限、全部文件语法、语言包 2 种 × 39 个 key、判断器 27/27、尺寸与文件名 31/31、顶层声明 27 个无撞名） |
| `npm run smoke` | ✅ 28/28（e4 桩测 13 + e6 让位与可点区域 10 + e7 速度预算 5） |
| `npm run live` | ⚠️ 上一轮 45/45（e5 真实站点 25 + e8 三主题 13 + e9 偏好与居中 7）。本轮 e9 新增 2 条几何断言（共 9 条），**未在本机复跑**（B6，没有开 9333 的 Chrome） |
| content 侧体积 | ✅ **47.7 KB / 60 KB**（余量 12.3 KB；i18n 占 +1.5 KB） |
| 速度（CPU 4×） | ✅ judge **0.005 ms** · 首帧 **22.1 ms** · 加载期 **2 个**监听（用满第六条的预算） |

## 模块状态

| 模块 | 文件 | 状态 | 证据 |
|---|---|---|---|
| 判断器 `judge()` | `src/content/detect.js` | ✅ | `test-judge` 27/27（含 cursor:pointer 3 条、正方形 5 条） |
| 点击契约（§3.1 三条放行） | `src/content/boot.js` | ✅ | 位移 > 6 px / 按住 > 600 ms / 按下时有选区，三条都在 `judge()` 之前判掉；e4 与 e5 全绿 |
| 让位检测 | `src/content/yield.js` | ✅ 真机已验 | e6：plain 开、sync 让、late 自关，7/7 |
| 命名空间 / 偏好 / 暂停列表 | `src/content/core.js` | ✅ | — |
| 尺寸比例格式 | `src/content/meta.js` | ✅ | `test-meta` 31/31（含 fileName） |
| 字节通道 | `src/content/bytes.js` + `src/background.js` | ✅ 真图已通 | e5：面板显示 `WEBP · 58 KB` |
| 视图层 overlay | `src/content/overlay.js` | ✅ | e4：开、transform 生效、背板淡入、Esc 后 host 摘除、DOM 逐字节一致 |
| 复制 / 保存 | `src/content/actions.js` | ✅ 代码 / ⚠️ 剪贴板未验 | 需真人点（合成事件没有瞬时激活）；单边 > 16384 或 > 32 MP 时降级为复制地址（D26），这条路径同样要真人验 |
| popup | `ui/popup.html` + `popup.js` | ✅ | 授权、按站点暂停、背景三选一；已授权时权限行不可见（e9） |
| 偏好跨上下文同步 | `core.js` + `overlay.js` | ✅ | popup 点按钮 → storage → 已打开的背板立刻换（e9 6/6） |
| welcome | `ui/welcome.html` + `welcome.js` | ✅ | 授权说明、暂停列表增删 |
| 文案与语言 | `_locales/{en,zh_CN}/messages.json` + `ui/i18n.js` + `Closer.t` | ✅ 页面已真机验 / ⚠️ overlay 未验 | `check-i18n` 2 种语言 × 39 个 key 双向比对；zh-CN 的 Chrome 里实测 manifest 名、popup、welcome（含 `3 个站点` / `1 个站点` / `恢复`、`<strong>` 未被转义）；overlay 的中文文案需要 host 授权才能注入，留给 manual-check 17 |
| 图标 16/32/48/128 | `icons/` + `tools/icons.py` | ✅ | 241 B – 1.7 KB，`python3 tools/icons.py` 可重生 |
| 实验 E1–E8 | `tools/lab/` | ✅ E2–E8 存在，E1 析出为 `tools/probe-yield.js` | 均需 CDP，未接入 CI；E8 已改为自包含桩页面，不再依赖外网 |

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
| T8 | 性能预算实测（宪法第六条） | CPU 4× 降速下 `judge()` < 1ms、首帧 < 100ms | ✅ e7 5/5：0.005 ms / 18.5 ms / 2 个监听 |
| T9 | ~~体积回收~~ | 改为**预算本身**：40 → 60 KB（宪法第六条修正，见 D21） | ✅ 关闭。压缩实现省了 289 B；余下 6.95 KB 是注释，删它违反第五条 |
| T10 | 视图层三处：chrome 唤回、顶栏吞点击、复制 tooltip | 淡出后指针一动就回来；顶部空白处点击能关闭；`⇧` 复制地址可见 | ✅ 已修，e4 13/13 + e5 24/24 未回归；手感由 manual-check 11/12 验 |
| T11 | 纯函数补测（ratio / humanBytes / formatOf / fileName / meta） | `npm run verify` 含 31 条断言 | ✅ 31/31 |
| T12 | popup 换背板 → 已打开的 overlay 立刻生效 | 点按钮后不等下次点击就变；关掉重开仍生效 | ✅ e9 6/6（真扩展 + 真授权 + 真按钮点击） |
| T13 | `verify` 在 Windows 上可跑 | `npm run verify` 三件事全绿，不出现 `D:\D:\…` | ✅ 2026-10-20 本机实测 |
| T14 | 跨文件顶层声明撞名纳入 `verify` | 注入一次重名 → 退出码 1 并指名两个文件 | ✅ 临时注入 `PAUSED_KEY` 验证，还原后重新变绿 |
| T15 | 中英国际化（D28） | 浏览器语言是中文时，manifest / popup / welcome / overlay 全中文且没有一处露出 key 名；`verify` 含语言包检查 | ✅ `check-i18n` 通过（临时去掉一个占位符 → 退出码 1 并指名 key）；zh-CN 真机已验 manifest / popup / welcome，overlay 见 manual-check 17 |

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
| B2 | E2–E8 需要 CDP 端口，未纳入 `verify` | 让位与视图质量靠手动跑 `smoke` / `live` | 作者决定是否接 CI |
| B3 | 隐私政策页（申请 all-urls 前必须有） | 上架前置 | 延后 |
| B4 | ~~content 侧余量不足~~ | 预算 40 → 60 KB 后余量 13.8 KB（46.2 KB / 60 KB） | ✅ 已解决（D21） |
| B6 | **`smoke` / `live` 未在 Windows 上复跑** | e4 的路径修复只做了语法与逻辑核对，没在真实 CDP 下跑过一轮；e4 现在读的是 `join(ROOT, 'src/content', file)`，本机没有开 9333 的 Chrome 无法验证 | 作者，装一次 Chrome 调试端口后跑 `npm run smoke` |
| B5 | **手工验收未做**（`docs/manual-check.md` 12 条） | 授权链路、剪贴板、真实站点让位都只有代码，没有一次真人走通 | 作者，约五分钟 |

## 本轮修掉的 bug（都留下了断言）

| bug | 怎么发现的 | 断言 |
|---|---|---|
| **中文下「暂停」竖排成两个字**：站点名（超长子域，或 popup 被当成标签页打开时的 32 位扩展 id）是不可断开的 token，而 flex 项的 `min-width` 默认是 `auto`，它拒绝变窄，把按钮压到只剩一个字宽；英文没有断行点只会溢出，中文逐字折行才露出来 | 用户截图：状态行写着「已在所有站点生效」，右边按钮却竖排两行 | 站点名 `min-width:0` + `text-overflow:ellipsis` 让位，按钮 `flex:none` + `white-space:nowrap`；完整站点名挂到 `title`；e9 新增两条几何断言（按钮高 ≤ 34px、按钮不出行框且站点名让到按钮左侧） |
| **窄窗口下大图偏右下、右侧被裁**：`.photo` 用 `inset:0 + margin:auto` 居中，但它的布局尺寸是**原图像素**；一旦比视口大，CSS 规范下 `margin:auto` 不产生负边距，元素退化成 `left:0/top:0`，靠 transform 缩完就偏右下 | e5 在 500×288 的窗口里报「适应后完整在视口内」失败，量到 `217×271 @ 292,9`，右边 509 > 500 | 改成 `left/top:50%` + `translate(-50%,-50%)`，居中不再依赖元素尺寸；e9 新增窄视口断言 |
| **e6 在 `npm run smoke` 里偶发 3 项失败**（S1/L1/L3），单独连跑两次均 7/7。未定位，怀疑是 e4 之后的端口/时序残留 | 一次全量 smoke 出现，随后复跑不复现 | 待观察，暂不阻塞 |
| **H5 活动页的卡片被接管**（用户报的 bad case）：整卡是 `<section>` + JS 事件委托，不是 `<a>`/`<button>`、无 role、无 onclick 属性，判断器前十条全漏；而它点击后只改自己某个元素的文字/class，`href`、`fullscreen`、命中点、滚动锁四个判据**全部沉默**——D9 的「行为即检测」在这个形态上有结构性盲区 | 用户提供页面与截图；实测点击后 `url` 未变、无弹层、无 fixed 覆盖、`body` 只长 28 字符 | 新增判断器第 11 条（`cursor:pointer` 认声明边界，D24）；e6 新增 card 用例，test-judge 加 3 条；真实页面上卡片被拦、页头大图仍能打开 |
| **popup 换背板，已打开的那张不跟着变**：`core.js` 的 `storage.onChanged` 只更新了 `state.prefs`，没让正在显示的 overlay 重新应用；要等下次点击才生效。暂停列表那条分支早就调了 `overlay.close()`，prefs 这条漏了 | 用户截图对比 | e9 六条：真扩展里点 popup 按钮，已打开的背板在 80 ms 内变色 |
| **e7/e8/e9 会因窗口大小假红**：点击坐标取自元素几何，而这三个测试从不约束视口。窗口被缩到 583×311 后，1200×800 图的中心落在视口外，`elementFromPoint` 返回 null，报「overlay 没打开」——看起来像产品坏了 | 连跑 e7 三次稳定失败；加诊断打印 `vw/vh/at` 才看清 | 三个测试统一 `Emulation.setDeviceMetricsOverride` 1280×900，e7 连跑三次 5/5 |
| **e5 用整页 outerHTML 长度当「DOM 已还原」的判据**：真实站点上第三方脚本随时改 DOM（实测评论区被挂 `style="!important"`，凭空 +19 字符），断言因此误红 | 打印首个差异位置，发现改动在 `#comments`，与图片查看无关 | 判据改为「`<html>` 属性与子节点数未变」，逐字节还原仍由 e4 在可控桩页面验 |
| **已授权却仍显示「Needs site access / Allow」**：`popup.js` 里 `permRow.hidden = granted` 一直是对的，但 `ui.css` 的 `.row{display:flex}` 盖掉了 UA 的 `[hidden]{display:none}`（特异性只有 0,1,0）。JS 在设，页面不认 | 用户截图：状态是绿色「On for every site」却还挂着 Allow 按钮 | `ui.css` 加 `[hidden]{display:none!important}`，实测 hidden 态 computed display 为 `none` |
| **chrome 淡出后唤不回**：`wake()` 只在拖拽分支里调用，而 `.bar.idle` 带 `pointer-events:none`，`pointerenter` 永远收不到。用户必须滚轮或拖拽才能把按钮找回来 | 读代码；设计 5.2 明写「指针一动就回来」 | `manual-check` 第 11 条（自动化测不了手感） |
| **整条顶栏吞掉「点背板关闭」**：`.bar` 是 `left:0;right:0` 的 flex 容器，两端之外都是命中区，点中 `onBar` 就不关闭 | 读代码 | `manual-check` 第 12 条 |
| **`⇧` 复制地址不可发现**：设计 5.4 要求 tooltip 写明，实现里一个 `title` 都没有 | 读代码 | — |
| **设计 §3.1 三条放行规则没实现**：拖 20 px 再松手、按住 600 ms、按下时有选区，三种都仍会打开 | 对照设计读 `boot.js` | 四条断言在 `test-judge` 外的路径上，靠 e5 全绿证明没伤到正常点击 |
| **E8 依赖外网站点**：图片解码与否取决于网络，`live` 里随机红一条，且错的那条看起来像产品 bug | 连跑三次，失败轮次每次不同 | 改为本地桩页面后连跑三次 13/13 |
| 背板透明，页面原图透出来 | 截图看出来的；`.dark .backdrop` 在 shadow 内匹配不到 host 上的类，要写 `:host(.dark)` | e4「背板不透明」+ e8 三主题「背板底色」 |
| 退场动画期间重新打开，`teardown()` 会把新 overlay 拆掉 | 读代码 | — |
| **桩测试被真扩展「让位」骗了**：残留的 Closer 扩展会注入 e4 的 `127.0.0.1` 页面并抢先 open，主世界的桩脚本随后 `acted()` 判定「页面动过了」主动让位。结果页面只有一个 `#closer`（扩展的），width / transform / backdrop 全对，但主世界的 `isOpen()` 是 false。**让位检测本身是对的，它只是被测试环境骗了** | 给 `open()` 与 `isOpen()` 埋点，发现 `open()` 从未进入主世界 | e4「环境干净」；三个桩测试开头自动 `clean()`；`tools/lab/clean-extensions.mjs` |
| **临时扩展实例无限堆积**：e5/e6 每次 `mkdtemp` 一个新目录，unpacked 扩展的 id 由路径决定，于是每跑一次就永久多一个实例（堆到 8 个）。这些实例会往 `*://*/*` 注入，包括 e4 的 `127.0.0.1` 桩页面，同一次点击上两个实例抢活，让 e4 报出「overlay 没打开」这种完全误导的失败 | 浏览器截图里看到 8 个 Closer | e4「环境干净：页面上只有一个 overlay」；e5/e6 改用固定路径并在结束时卸载 |
| **迟到纠正永远不触发**：`covered()` 用 `elementFromPoint`，而 overlay 自己是 fixed + 最高 z-index，取到的永远是我们自己，站点在下面挂查看器完全看不见 | e6 的 `late` 场景（先开、800ms 后站点挂查看器、再等 1.5s 没关） | e6「L2 站点慢挂查看器后，我们自己关掉」 |
| `ms(1)` 误当 reduced-motion 判据 | 读代码 | — |
| **`npm run verify` 在 Windows 上必然失败**：`tools/check-manifest.mjs`、`tools/lab/e4-overlay.mjs` 用 `new URL('..', import.meta.url).pathname` 当根目录 | 本机跑 verify，ENOENT `D:\D:\Programming\Closer\manifest.json`。`pathname` 是 `/D:/…`，`path.join` 又加了一遍盘符 | 两处改为 `path.resolve(import.meta.dirname, …)`；`decisions.md` 的「默认假设」记下「路径一律由 path API 生成」 |
| **跨文件顶层 `const` 撞名，`verify` 结构上查不出** | 读 `core.js` 注释时确认：8 个 content 文件共用一个全局词法环境，重名是 SyntaxError，而第 4 节是逐文件 `node --check` | `check-manifest` 新增第 5 节；临时注入 `const PAUSED_KEY` 验证会失败并指名 `core.js + detect.js`，还原后变绿 |
| **复制大图可能把标签页 OOM 掉**：`MAX_BYTES` 管字节不管像素，64 MB 的 JPEG 能解出 300 MP（约 1.2 GB RGBA） | 读复制链路时发现的预算错配：唯一的兜底是 `toBlob` 返回 null，而那时像素缓冲已经分配了 | `toPng` 建 canvas 前判单边 16384 / 面积 32 MP，超限退回复制地址并 toast（D26） |
| **`aria-modal="true"` 与「不抢焦点」自相矛盾** | 读 `ensure()`：声明了模态，却把 `tabIndex` 设为 -1 且从不 focus | 去掉 `aria-modal`，只留 `role="dialog"`（D27），代价写进 decisions |
| **meta 缓存把一次失败钉死** | `bytes.js` 的 `lastMeta` 是 Promise，resolve(null) 仍然 truthy，于是同一 URL 之后永远命中失败缓存 | 失败时清空 `lastUrl` / `lastMeta`；下次打开同一张图会重新探测 |
