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
**2026-10-21 第五轮（叠层查看器，cases 006）**：站点自己的查看器开着时，点里面那张图会再叠一层。根因不是判据太窄，是让位四判据全是**增量**——第二次点击时页面早就动手完了，四项同时沉默，站点自己的缩放也看不见（命中点比的是元素身份）。修法不是加尺寸阈值，而是让「页面接管了」这个观测有寿命：`acted()` 命中时记住页面多出来的那一层（`Closer.state.shell`），后续点击只要还在这层里就继续让位，层被卸载即忘掉（D28）。站点级自动黑名单被否决——一次观测赌整站行为，换来不可解释的整站失效。新增 `e10` 五场景、`e6` 加 S3/L4，smoke 从 30 条变 43 条。

代码写完了，131 项自动断言全绿。但自动化一直用「临时副本 + 声明式 host 权限」绕过真实授权，
所以 **`安装 → welcome → 点 Enable → 授权 → 动态注册` 这条链路一次都没被真人走通过**。
按 `docs/manual-check.md` 走一遍（16 条），才算真的可上架。

| 验收 | 结果 |
|---|---|
| `npm run verify` | ✅ 通过（6 个 manifest 引用、3 项权限、全部文件语法、判断器 27/27、尺寸与文件名 31/31、顶层声明 32 个无撞名） |
| `npm run smoke` | ✅ **43/43**（e4 桩测 15 + e6 让位 12 + e10 叠层 11 + e7 速度预算 5），2026-10-21 在 Windows 本机复跑 |
| `npm run live` | ⚠️ 本轮未复跑（依赖外网真实站点；本轮只动让位路径，e5 的旧结果保留） |
| content 侧体积 | ✅ **51.9 KB / 60 KB**（余量 8.1 KB） |
| 速度（CPU 4×） | ✅ judge **0.010 ms** · 首帧 **34.2 ms** · 加载期 **2 个**监听（用满第六条的预算） |

## 模块状态

| 模块 | 文件 | 状态 | 证据 |
|---|---|---|---|
| 判断器 `judge()` | `src/content/detect.js` | ✅ | `test-judge` 27/27（含 cursor:pointer 3 条、正方形 5 条） |
| 点击目标解析 `pick()` | `src/content/detect.js` | ✅ | target 不是图时按命中点栈找回，并逐层下钻 shadow root（`cases.md` 004 / 005）；e4 两条形态断言 + 真实图库页实测 |
| 点击契约（§3.1 四条放行） | `src/content/boot.js` | ✅ | 位移 > 6 px / 按住 > 600 ms / 按下时有选区 / 点中链接或控件，都在 `judge()` 之前判掉；e4 与 e5 全绿 |
| 让位检测 | `src/content/yield.js` | ✅ 真机已验 | e6 12/12（含「查看器里再点一次」S3、慢挂后 L4）；e10 11/11（缩到 0.35 仍不接管、层关闭后自愈 S4） |
| 存量判据 `shelled()` | `src/content/yield.js` | ✅ | `acted()` 命中时 `remember()` 记下盖住视口的那一层；`isConnected` 或覆盖失效即忘掉（D28） |
| 命名空间 / 偏好 / 暂停列表 | `src/content/core.js` | ✅ | — |
| 尺寸比例格式 | `src/content/meta.js` | ✅ | `test-meta` 31/31（含 fileName） |
| 字节通道 | `src/content/bytes.js` + `src/background.js` | ✅ 真图已通 | e5：面板显示 `WEBP · 58 KB` |
| 视图层 overlay | `src/content/overlay.js` | ✅ | e4：开、transform 生效、背板淡入、Esc 后 host 摘除、DOM 逐字节一致 |
| 复制 / 保存 | `src/content/actions.js` | ✅ 代码 / ⚠️ 剪贴板未验 | 需真人点（合成事件没有瞬时激活）；单边 > 16384 或 > 32 MP 时降级为复制地址（D26），这条路径同样要真人验 |
| popup | `ui/popup.html` + `popup.js` | ✅ | 授权、按站点暂停、背景三选一；已授权时权限行不可见（e9） |
| 偏好跨上下文同步 | `core.js` + `overlay.js` | ✅ | popup 点按钮 → storage → 已打开的背板立刻换（e9 6/6） |
| welcome | `ui/welcome.html` + `welcome.js` | ✅ | 授权说明、暂停列表增删 |
| 图标 16/32/48/128 | `icons/` + `tools/icons.py` | ✅ | 241 B – 1.7 KB，`python3 tools/icons.py` 可重生 |
| 实验 E1–E10 | `tools/lab/` | ✅ E2–E10 存在，E1 析出为 `tools/probe-yield.js` | 均需 CDP，未接入 CI；E8 已改为自包含桩页面，不再依赖外网；E10 已进 `npm run smoke` |

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
| T15 | 点击目标解析：图被透明装饰盖住时不生效 | 点遮罩能打开下面的图；点链接/控件仍放行；shadow tree 内同样成立 | ✅ e4 15/15（light DOM + Web Component 两条）+ 真实图库页实测打开 |
| T16 | 叠层查看器：站点查看器开着时再点图不接管（cases 006） | 第二次点击不接管；站点缩到 25% 仍不接管；app 外壳里的缩略图照常打开；关掉查看器后自愈 | ✅ e10 11/11 + e6 S3/L4 |

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
| B6 | ~~`smoke` / `live` 未在 Windows 上复跑~~ | 2026-10-21 本机跑通 `npm run smoke` 43/43；`live` 仍依赖外网真实站点，未复跑 | ✅ 已解决（`live` 部分仍待有网时跑一次） |
| B5 | **手工验收未做**（`docs/manual-check.md` 12 条） | 授权链路、剪贴板、真实站点让位都只有代码，没有一次真人走通 | 作者，约五分钟 |

## 本轮修掉的 bug（都留下了断言）

| bug | 怎么发现的 | 断言 |
|---|---|---|
| **站点自己的查看器开着时，点里面那张图会再叠一层**（用户报的 bad case，站点后来找不到了）：第一次点击站点弹出全屏遮罩并展示原图，第二次点遮罩里的图 → 我们也弹一层 | 用自包含桩页复现（e10 先红后绿）：第二次点击前后 `href` / 全屏 / 命中点 / 滚动锁四项完全一样，全部沉默；`zoom` 变体进一步证明连站点自己的缩放都看不见——命中点比的是元素身份，`transform` 不改身份。静态尺寸阈值也不行：站点一缩小，缩略图与查看器里的图分不出 | `e10` 11 条（static / zoom / zoomout / 自愈 / app 外壳）+ `e6` S3、L4 |
| **同一形态的 Web Component 版仍然失效**：站点把「图 + 遮罩」放进 `open` shadow root。事件层是穿透的（`composedPath()[0]` 就是 shadow 里的遮罩），但 `document.elementsFromPoint` **只返回 host**，`pick()` 在 light DOM 里找不到图 → 又变成「点了没反应」。四形态实测顺带证明缺口不在「shadow 里的图」：直接点 shadow 内的 `<img>` 时 `composedPath()[0]` 就是 img，一直能打开 | 一次性实验页跑四形态：light 遮罩 ✓ / open shadow 遮罩 ✗ / open shadow 直接点图 ✓ / closed shadow ✗；修后同一脚本复跑：前三条全 ✓，closed 仍 ✗（边界） | `pick()` 增加逐层下钻 `shadowRoot`（≤ 3 层）；e4「shadow tree 里的遮罩：下钻后也能打开」（`cases.md` 005） |
| **图库详情页点了没反应**（用户报）：图上方盖一层 `position:absolute; inset:0` 的透明致谢装饰，`cursor:auto`、无 `<a>`、无 `role`。`click` 的 target 是装饰层，`target.closest('img')` 为空，处理器在 `judge()` 之前就 return；页面自己也不响应，于是既没打开也没让位。<br>**判断器没有沉默**（925×573 / 830×514，十三条全过），沉默的是「点是哪张图」这一步——这是 `judge()` 管不到的地方 | 用户给 URL + 截图；用 `elementsFromPoint` 打出命中栈，第一层就是 `.photo__centered-frame__overlay`，它是图的兄弟节点 | 新增 `Closer.pick()`（检测 target 不是图时按命中点栈找回，要求共享非 `body` 祖先、装饰是链接/控件则放行）；e4「透明遮罩盖着的图，点遮罩也能打开」；真实页面实测 `pick` 命中、`judge` 为 true、overlay 打开 |
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
