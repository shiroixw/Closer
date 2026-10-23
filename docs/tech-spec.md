# Closer — 技术方案

`design-v0.1.md` 已经定下架构（无构建、文件划分、SW 取字节、Shadow DOM、让位检测）。
这份文件解决**实现级的五个难点**：模块契约、时序、坐标数学、让位检测、视图层。

写代码前先看第 12 节——有三个实验必须在动手之前跑完，其中任何一个不成立，产品就要改设计。

---

## 1. 模块契约与数据流

单向依赖，没有循环。每个文件只做一件事，全部挂在 `window.Closer` 上。

```
core.js      Closer.host / Closer.state{ready, paused, prefs}
             await Closer.load() / pauseHere() / setBackdrop(name)

detect.js    Closer.judge(img) -> boolean            纯函数，无副作用
             Closer.pick(target, x, y) -> img | null  点击对应的是哪张图

yield.js     Closer.snapshot(x, y, img) -> Baseline        img 供 skin 判据记基线
             Closer.acted(baseline) -> 命中的判据名 | ''
             Closer.shelled(img) -> boolean          页面是否已经在自己那层里展示它
             Closer.remember(node) -> void           记下页面刚动出来的那一层
             Closer.covered(baseline) -> Element | null
             Closer.isOurs(node) -> boolean

meta.js      Closer.meta(img) -> { url, nw, nh, sw, sh, ratio, mp, format }
             Closer.ratio(w,h) / humanBytes(n) / formatOf(url)

bytes.js     Closer.bytes(url) -> Promise<{ buf, mime } | null>    按 url 缓存一条

overlay.js   Closer.overlay.open(img, media) / close() / isOpen()

actions.js   Closer.copyImage({buf, mime}) -> Promise<void>
             Closer.saveImage({buf, mime}, name) -> Promise<void>

hint.js      Closer.hint.attach() / reset()
             悬停提示：判得开的那张图给原生 zoom-in，离开即还原（D32）

boot.js      接线。唯一允许调用上面所有东西的地方。
```

调用方向：`boot → detect → (yield) → bytes → overlay → actions`。`overlay` 不认识 `boot`，`detect` 不认识任何人。

`pick()` 是 `judge()` 的前一步。图上方常盖着一层透明装饰（图库的致谢遮罩、卡片的悬停层），点击落在装饰上，`target.closest('img')` 什么也找不到——只看事件目标，这整类站点表现为「点了没反应」。所以 target 不是图时用 `elementsFromPoint` 把图找回来，三条边界：装饰本身是链接/控件就放行（那是页面的意图）；图必须与点击共享一个**非 body** 的祖先，否则点浮层、点页头会把下面任意一张图拽出来（`cases.md` 004）；命中栈顶是带 `shadowRoot` 的宿主时下钻（`ShadowRoot.elementsFromPoint`），最多 3 层——`elementFromPoint` 不穿 shadow，站点把图与遮罩做进 Web Component 时只有下钻才看得见（`cases.md` 005）。`sameFrame()` 是下钻的唯一信任来源，隔着组件猜出来的图会被它挡掉。

`bytes.js` 是 `design-v0.1.md` 第 6 节文件表里后来补上的一项：取字节被 `meta`（要大小）、`actions`（要内容）和 `overlay`（显示）三方需要，抽出来才能只请求一次。

`hint.js` 是收尾时补的第三个消费方：它不判断，只把 `judge()` 的结论翻译成浏览器原生手势。三条约束写死在实现里：① 只在 `judge()` 通过、`shelled()` 为假、站点未暂停、overlay 未打开时写；② 页面自己的手势优先——`getComputedStyle(img).cursor !== 'auto'` 一律不碰；③ **`boot` 必须在 `snapshot()` 之前调 `reset()`**：`skin` 判据读的是 `style` 属性，我们的撤销若跨过那次基线，页面明明没动也会被判成「认领了这次点击」（一个会被误判成让位的自伤）。悬停用 `pointerover` 而不是 `pointermove`：前者只在目标元素变化时触发，定位也只算一次，不必按帧跟随。

---

## 2. 状态机与时序

```
idle ──click(候选)──> pending ──acted()──> idle
                         │
                         └──!acted()──> open ──Esc──> closing ──> idle
```

- `pending` 期间再来一次点击：丢弃前一个 pending，重新开始。不排队。
- `pending` 不得跨越导航：rAF 里先验 `location.href`，变了就不开。
- 候选进 `pending` 之前先过 `shelled()`：页面已经在自己那层里展示这张图时直接放行，连 `preventDefault()` 都不做（4.5）。
- 所有状态转换只发生在 `overlay` 内部，外部只能 `open` / `close`。

时序上唯一必须守住的一条：**从 `click` 到 `open` 只允许隔一次 rAF。** 中间任何东西都不能是 `await`——`chrome.storage` 早在 `boot` 阶段读完了，`judge` 是纯同步的，`bytes` 是打开之后才发。

```js
// click 处理器里，同步完成
e.preventDefault();
const base = Closer.snapshot(e.clientX, e.clientY);
settle(() => {
  if (!Closer.acted(base)) Closer.overlay.open(img, base);
});
```

`settle` 同时挂 rAF 和 `setTimeout(…, 32)`，谁先到用谁，用标志位互斥：后台标签页里 rAF 不一定会触发。

---

## 3. 坐标数学

这是最容易写错、且错了最明显（缩放往反方向跑）的一块。

### 3.1 模型

`.photo` 用 `inset: 0; margin: auto` 加显式宽高，所以元素的**中心恒等于视口中心** `C = (vw/2, vh/2)`，`transform-origin: center`。

```css
transform: translate(tx, ty) rotate(r) scaleX(f) scale(s);
```

一个元素局部坐标 `p`（以元素中心为原点、未缩放未旋转的 CSS px）映射到屏幕：

```
screen(p) = C + T + R(r) · S(f, s) · p
```

### 3.2 三个操作

**平移**：`T += (dx, dy)`，屏幕像素，精确。

**适应**：`s = min(0.94·vw / W, 0.94·vh / H)`，上限 4，`T = 0`。
其中 `W, H` 要**按旋转后的有效尺寸**取——转了 90° 或 270° 时 `(W, H) = (nh, nw)`。忘了这一步，旋转后适应就溢出屏幕。

**以指针 P 为锚点缩放**（`s → s'`）：

```
T' = P - C - (s'/s) · (P - C - T)
```

这个式子**在旋转和翻转下都精确**，不是近似。因为 `S'·S⁻¹ = (s'/s)·I`：均匀缩放加上 `±1` 的翻转，其比值仍是标量单位阵，所以 `R·S'·S⁻¹·R⁻¹` 退化成同一个标量，与 `R` 无关。这一点值得记住——否则会去写一堆本不必写的矩阵求逆。

键盘缩放锚在 `C`，代入即 `T' = (s'/s)·T`：图像中心不动，偏移同比放大。

### 3.3 滚轮的输入归一

```js
let dy = e.deltaY;
if (e.deltaMode === 1) dy *= 16;                 // 按行
else if (e.deltaMode === 2) dy *= innerHeight;   // 按页
const next = s * Math.exp(-dy * 0.0018);         // 指数，快慢手感一致
```

`e.ctrlKey` 为真时是触控板捏合，走同一条路径，不要另开分支。

### 3.4 开启动画（FLIP）

起始：`s0 = rect.width / nw`，`T0 = rect.center - C`。目标：`s_fit`, `T = 0`。
两者都线性插值即可——同时插值「中心点」和「尺寸」，视觉上就是正确的 FLIP，不需要插值四个边。

关闭时反向：读源图**当前**的 rect。源图已脱离文档或宽高为 0 时，退化为淡出。

---

## 4. 让位检测的实现

`design-v0.1.md` 3.2 的五个判据，落地时有五处细节决定成败。

### 4.1 基线必须在 click 里同步取

```js
function snapshot(x, y, img) {
  return {
    href: location.href,
    fullscreen: document.fullscreenElement,
    scrollLocked: scrollLocked(),
    hit: document.elementFromPoint(x, y),
    skin: skinChain(img),   // 图自己 + 五层容器的 style/class，见 4.6
    x, y,
  };
}
```

`hit` 记的是**元素引用**，不是「是不是那张图」。卡片布局里图片上方常年盖着一层链接或遮罩，按「是不是图」判会永远误判成「页面动过了」，产品当场失效。只有引用相等才是「没有新东西盖上来」。

### 4.2 判据顺序按代价排，并且短路

```js
function acted(b) {
  if (location.href !== b.href) return true;                    // 最便宜
  if (skinChanged(b.skin)) return true;                         // 十几次属性读取，见 4.6
  if (document.fullscreenElement !== b.fullscreen) return true;
  const hit = document.elementFromPoint(b.x, b.y);              // 中等
  if (hit !== b.hit && !isOurs(hit)) return true;
  return scrollLocked() !== b.scrollLocked;                     // 强制样式计算，放最后
}
```

`scrollLocked()` 会触发样式重算，所以放在最后；前面任一命中就不必再算。

### 4.3 「自己」必须被排除

打开之后，`elementFromPoint` 落在我们自己的 shadow 树里，引用当然不等于基线。不排除它，overlay 一打开就会把自己判成入侵者、立刻关掉自己。

```js
function isOurs(node) {
  return !!node && (node === host || node.getRootNode() === shadow);
}
```

### 4.4 迟到纠正

打开后挂 `600ms` 与 `1200ms` 两个定时器，各自跑一次检查；成立就**静默**关闭（不做退场动画，避免用户以为是自己关的）。关闭时清掉未触发的定时器。

这里有个**会让整个机制失效**的坑：检查不能复用 `acted()`，更不能直接用 `elementFromPoint`。

overlay 自己是 `position: fixed; inset: 0; z-index: 2147483647`，打开之后 `elementFromPoint(x, y)` 永远返回我们自己的 host。拿它去比对基线，结果恒为「页面没动」——迟到纠正一次都不会触发，而且表面上一切正常（站点查看器叠在我们下面，用户看到的是双开）。

正确写法是 `elementsFromPoint` 拿整条视线，从前往后剪掉自己，再看剩下的第一个是不是基线元素：

```js
for (const node of document.elementsFromPoint(b.x, b.y)) {
  if (!Closer.isOurs(node)) { under = node; break; }
}
return !!under && under !== b.hit;   // 现在返回 under 本身，供 4.5 记住那一层
```

`acted()` 不受影响：它在 overlay 打开**之前**调用，那时 host 还不存在。两条路径用两种取法，是刻意的。

### 4.5 存量判据：记住页面接管的那一层

`acted()` 的四个判据全是**增量**，它们默认「页面还没动手」。站点自带查看器时这个前提不成立：第一次点击页面接管之后，后续每一次点击都发生在已经接管的状态里，四项前后完全一样，全部沉默（`cases.md` 006）。站点自己的缩放更看不见——命中点比的是元素身份，`transform` 不改身份。

所以再加一个**存量**判据，问的是一句话：页面是不是已经在自己开的那一层里展示这张图。

```js
// 页面出手的那一刻：从命中点往上找它盖在屏幕上的那一层。anchor 是点击前命中点上的元素。
Closer.remember = function (node, anchor) {
  if (!node || Closer.isOurs(node)) return;

  // ① 命中点往上第一个盖住 90% 视口的祖先
  let layer = null;
  for (let n = node, i = 0; n && i < 8; i++) {
    if (n === document.body || n === document.documentElement) return;   // body 是万能祖先
    if (coversViewport(n)) { layer = n; break; }
    const root = n.getRootNode();
    n = n.parentElement || (root instanceof ShadowRoot ? root.host : null);  // 祖先链不穿 shadow
  }
  if (!layer) return;

  // ② 扩到「这一层」的根：遮罩与图常常是兄弟，只记遮罩就 contains 不到图
  for (let p = layer.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    if (!coversViewport(p)) break;
    if (anchor && p.contains(anchor)) break;   // 再往上就把点击前的页面圈进来了
    layer = p;
  }

  // ③ 页面本来就在的全屏外壳不算「它接管出来的那一层」
  if (anchor && layer.contains(anchor)) return;

  Closer.state.shell = layer;
};

// 之后的每一次点击：只问那层还在不在、里面是不是这张图。
Closer.shelled = function (img) {
  if (document.fullscreenElement) return true;      // 全屏时我们开了也看不见
  const shell = Closer.state.shell;
  if (!shell) return false;                         // 常见路径：一次空值判断
  if (!shell.isConnected || !coversViewport(shell)) { Closer.state.shell = null; return false; }
  return shell.contains(img);
};
```

五个刻意的决定：

1. **挂接点复用既有的两处观测，不新增观察者；但每个判据命中都要记。** `acted()` 里 `hit`、`scroll`、`skin` 三条命中路径都调 `remember(now, b.hit)`；`watchLate` 里 `covered()` 返回被谁盖住，同样记一次——慢半拍的接管也是接管，不然它后面那一次点击照样会叠。**只挂在 `hit` 上是不够的**：真实站点开查看器时往往同时改写被点图片的 `style`/`class`，`skin` 先命中就直接 return 了，`shell` 永远是空的（cases 008）。
2. **不判断「它像不像查看器」。** 归因来自「它是在这次点击之后出现的」，这是证据不是猜测。所以没有图片尺寸、视口占比之类的阈值——站点把图缩到 25%、放大后拖到一边，结论不变。
3. **记这一层的「根」，但不圈进点击前那张图。** 遮罩与图在真实查看器里常常是兄弟（tdesign 的 `__modal-mask` / `__modal-pic`、iWiki 同理），只记住命中点落到的那一层，`contains(img)` 永远为假，等于没记；而一路爬到 `body` 又会把 app 外壳记成查看器。所以往上扩到「父级仍盖住视口、且没有把点击前那张图圈进来」为止，最后再用 `layer.contains(anchor)` 兜一次。锚点就是 `snapshot()` 里的 `hit`。
4. **`body` / `html` 永远不算那一层。** 否则 app 外壳（整站躺在 `fixed` 全屏容器里）会被认成查看器，整站失效（D24 的同一条教训）。
5. **判死即忘。** `isConnected` 为假、或不再盖住视口（被 `display:none` 掉）就清空。状态自愈，没有过期时间，也不落 storage——不产生用户看不见的站点名单。

**不记在站点上。** 「点一次发现页面消费了 → 这个域名以后都不接管」看似更省事，但 `acted()` 命中的原因远不止查看器（点卡片展开、tab 切换、SPA 软导航、慢挂广告）。一次观测去赌整站行为，换来的是不可解释、不可逆的整站失效（D28）。

**记得住的前提是我们看见了那一刻。** 页面加载即开着查看器、用键盘打开、点击后原地放大同一张图（元素身份不变、也没有新层）——这三类记不到，会叠一次，写进 `design §8`。若以后高频，补法是给 `shelled()` 加一个 OR 分支，主结构不动。

### 4.6 就地放大：站点改的是这张图，或它的盒子

Pexels 照片页的放大镜是同一张图的 `transform: scale(3)`，写在 `<img>` 的行内 style 上。它躲过了前四个判据的全部：没有导航、没有全屏、没有滚动锁，`elementFromPoint(x, y)` 依然是**同一个元素**——缩放改变的是它的绘制，不是它的身份。

所以多存一份「这个元素自己的外观」：

```js
function skinOf(el) {
  return (el.getAttribute('style') || '') + '\n' + (el.getAttribute('class') || '');
}
```

再把范围从 `<img>` 扩到它的盒子——**图自己 + 往上五层，到 body 为止**：

```js
function skinChain(el) {
  const out = [{ el, skin: skinOf(el) }];
  let n = el.parentElement;
  for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
    if (n === document.body || n === document.documentElement) break;
    out.push({ el: n, skin: skinOf(n) });
  }
  return out;
}
```

往上认，是因为同一个放大镜可以换个写法：class 加在包着图的容器上、CSS 去缩里面的图，图自己的属性一个字都不变。停下是因为 `body` / `html` 的 class 常年被菜单、主题、弹窗改写，那不是这次点击的证据；而真正的放大盒不会离图五层以上。

存的是**元素引用 + 当时的签名**，不是重新走一遍 `parentElement`：页面中途换了包裹层时，按结构重走会得到一条不同的链，白白让位。

**为什么是属性，不是几何。** `getBoundingClientRect()` 看起来更直接，但 `hover` 缩放、`transform` 过渡都是几何变化而不写属性——按几何判，所有带悬停放大的图库都会静默失效。而「点击之后站点改写了这张图自己（或它的盒子）」几乎只出现在「它认领了这次点击」的场合。

**为什么来得及。** 站点是在自己的 `click` 处理器里写 style / class 的，我们的捕获监听在 window 上先跑（取基线），`settle` 在下一帧（读变化），中间隔着一整个事件的传播。真机 Pexels 实测：基线 `transform:none`，下一帧 `scale(3)`，判据命中，overlay 一次都没出现。

**覆盖不到的。**
- 写在 `body` / `html` 上，或点击 600 ms 之后才写（迟到纠正只看命中点）；
- 只改 `src` / `srcset` / `data-*`——与懒加载的换图、换状态属性无法区分，故意不收；
- 只走 `element.animate()` 或内部 JS 状态、不写任何属性——隔离世界观测不到。

这三条都在 `design-v0.1.md` §8 的失败模式表里。按第二条，它们的方向都是「漏开」，可以接受。


---

## 5. 字节通道

### 5.1 协议

```
content → background   { type: 'closer:bytes', url, want: 'meta' | 'full' }
background → content   { ok: true, size, mime, base64?, tooBig? }
                       { ok: false, error: 'http' | 'network' }
```

**分两段，且内容必须 base64。** 两条都是被平台逼出来的：

- `runtime.sendMessage` 走 JSON 序列化，`ArrayBuffer` 到对面会变成 `{}`。传内容只能 base64。**但 blob 一定要在页面里造**——SW 造的 `blob:chrome-extension://…` 页面加载不了（见第 7 节）。
- 于是打开时只发 `want: 'meta'`：有 `content-length` 就直接用，没有就流式数一遍，**不缓冲**。复制和保存才发 `want: 'full'`。

打开即传整份内容，等于每次点击都付 1.33 倍图片体积的传输成本，直接违反「点击到首帧 < 100 ms」。复制是低频动作，多等一次已经命中的缓存，比让打开变慢便宜得多。（这一条推翻了本文件早先的「一次拿全」，见 D19。）

### 5.2 内存

完整字节（base64 → `Uint8Array`）只在复制/保存期间存在，用完即弃，不挂在 overlay 上。超过 64 MB 返回 `tooBig`，复制报 `Copy failed`。

**字节之外还有一道像素闸。** 64 MB 管不住像素：64 MB 的 JPEG 能解出 300 MP，画进 canvas 要 1.2 GB 的 RGBA，标签页会被 OOM 杀掉。所以 `toPng` 在 `img.decode()` 之后、建 canvas 之前判两道：单边 ≤ 16384（Chrome 的 canvas 上限）、总面积 ≤ 32 MP。超限返回 `null`，`copyImage` 退回复制地址并 toast —— 见 D26。保存不受影响，它走原始字节，不经 canvas。

### 5.3 两种 URL 不走 SW

`blob:` 与 `data:` 在页面上下文里同源可读，直接 `fetch(url)` 即可，省一次消息往返。`data:` 的大小从 base64 长度反推，不用真解码。

### 5.4 失败就是缺失

`fetch` 抛错、`!res.ok`、超时（8s）——一律返回 `null`。信息面板里那一行**整行不显示**，不写「未知」。复制与保存则报 `Copy failed`（不静默）。

---

## 6. 视图层

`design-v0.1.md` 第 5 节说的是「长什么样」，这里说「怎么让它成立」。

### 6.1 DOM 与层级

```
host  (#closer, position:fixed; inset:0; overflow:hidden; all:initial; z-index:2147483647)
└ shadow
  ├ .backdrop      背景（深/浅/棋盘），独立的 opacity 层
  ├ .photo         图片，absolute + inset:0 + margin:auto + 显式宽高
  ├ .chrome        absolute; top:0; left:0; right:0
  │  ├ .info       左上 ⓘ
  │  └ .actions    右上：复制 / 保存 / 关闭
  ├ .panel         信息面板，absolute; top:56; left:14; width:232
  └ .toast         role=status，底部居中，只在失败时出现
```

`.backdrop` 必须和 `.photo` 平级，不能是 `.photo` 的父级——开启动画里图片要从缩略图尺寸连续放大，而背板是独立淡入的，两者时长不同。

`overflow: hidden` 放在 host 上：放大后的图要裁在视口内，不能让页面出现滚动条。

### 6.2 事件所有权

overlay 打开期间，哪些事件必须被吃掉，在哪一层吃：

| 事件 | 监听位置 | 处理 |
| --- | --- | --- |
| `wheel` | window / capture / `passive: false` | `preventDefault` + 缩放 |
| `keydown` | window / capture | 拦我们的键，**外加 `Space` `PageUp` `PageDown` `Home` `End` `←→↑↓`** |
| `pointerdown` `pointermove` `pointerup` `pointercancel` | `.stage` | 拖拽，`setPointerCapture` |
| `dblclick` | `.photo` | 切换 fit ↔ 100% |
| `dragstart` | window / capture | `preventDefault`，防拖拽幽灵 |
| `selectstart` | window / capture | `preventDefault`，防选中 |
| `contextmenu` | **不拦** | 允许「图片另存为」，那是浏览器的正当行为 |
| `click` | 不拦 | 背板点击关闭在 `.stage` 自己处理 |

**最容易漏的一条是第二行加粗的那几个键。** 只拦 `Esc` `0` `1` `R` `F` `B` `I` `Enter` 是不够的：空格和方向键、`PageUp/PageDown`、`Home/End` 会漏给页面，页面在 overlay 背后滚动。用户看不到图在动（图是 fixed 的），但一关掉 overlay，人已经在页面别处了。

`wheel` 必须显式 `{ passive: false }`，否则 `preventDefault` 不生效，页面照样滚。

### 6.3 渲染策略

**不做 rAF 循环。** 只写 `transform`，靠 CSS transition 承担插值——用渲染循环去追指针是没必要的复杂度（也违反第六条）。

| 场景 | transition |
| --- | --- |
| 拖拽、滚轮 | `none`（有任何缓动都会有"跟不上手"的延迟感） |
| 键盘缩放、`0`/`1`、双击 | `transform 180ms cubic-bezier(.22,.72,.18,1)` |
| 开启 / 关闭（FLIP） | `transform 260ms cubic-bezier(.22,.72,.18,1)` |

只动 `transform`，绝不动 `left/top/width/height`：前者在合成层上跑，不触发布局。

`will-change: transform` 只在打开期间挂着，关闭时移除。超大图上它会吃显存。

### 6.4 手势

```js
pointerdown → { x, y, T, moved: false, id } + setPointerCapture(id)
pointermove → 位移 > 3px 才置 moved，进入 .dragging（cursor: grabbing）
pointerup   → 未 moved 且落在背板上 → 关闭
pointercancel → 复位，不关闭
```

阈值 3px 是为了让「手抖的点击」仍然是点击。只处理主键与 `pointerType: mouse | pen`，多指手势 v0.1 不做。

### 6.5 chrome 的自动隐藏

- 2.2 s 无操作 → `.idle`：`opacity: 0; pointer-events: none`
- 唤出：`pointermove`、任何被我们吃掉的 `keydown`
- **面板打开时不隐藏**。否则用户正读着信息，它自己淡了
- 指针停在 chrome 上时暂停计时
- 淡出用 `opacity .18s ease`，不用 `visibility`（那会丢焦点）

### 6.6 信息面板的开合

- 用 `hidden` 属性控制，不用 `<details>`（样式控制力不够）
- 点外关闭：window capture 上的 `pointerdown`，用 `e.composedPath().includes(panel)` 判断——`contains()` 穿不透 shadow，`composedPath` 可以
- `Esc` 两级：面板开着就只收面板，再按一次才关 overlay
- 展开动画只做 `opacity` + `translateY(-4px)`，**不做高度动画**——高度动画每帧触发 layout

### 6.7 焦点与痕迹

- host 设 `tabindex="-1"`，但打开时**不 focus 它**。键位靠 window capture 收，不需要焦点
- 不记录、也不恢复 `document.activeElement`——因为我们从未改变过它
- 关闭后，用户按下一次按键仍落在原来的输入框里。这是第三条（页面主权）最容易被忽略的一处兑现

### 6.8 加载失败与大图

- 尺寸直接取源图的 `naturalWidth/Height` 先写上，避免等 `decode` 造成的布局跳动
- `photo.onerror` → **直接关闭，不显示任何东西**。源图刚刚还在页面上显示着，走到这一步说明 URL 已失效；一个空的黑幕比没有更糟，而"没反应"用户会理解的
- `naturalWidth > 8192` 时浏览器会自动降采样，不要自己处理；`fit` 仍按真实尺寸算
- 旋转 90° 后 `fit` 用有效尺寸，见 3.2

### 6.9 无障碍（最低限度，但必须)

- host：`role="dialog" aria-modal="true" aria-label="Image viewer"`
- `ⓘ`：`aria-expanded` 跟随面板开合
- 三个按钮各有 `aria-label`
- `Copy failed` 的 toast：`role="status" aria-live="polite"`
- 不做完整的焦点陷阱（v0.1 不做），但 `Esc` 必须永远能把人放出去

### 6.10 单例

模块级一个实例。`open()` 在 `pending` 或 `open` 态直接返回，不重建、不叠加。`close()` 只置状态和清定时器，DOM 留着复用——第二次打开比第一次快，也少一次内存分配。

### 6.11 光标

| 区域 | cursor | 语义 |
| --- | --- | --- |
| 背板 | `zoom-out` | 点这里会关掉 |
| 图片 | `grab` / 拖拽时 `grabbing` | 这是被看的东西，点它不关 |
| 页面上的图（页面自己没声明 cursor） | `zoom-in`（悬停 140 ms 后才写） | 这张图点下去会打开（`judge()` 通过），D32 |

用背板的 `zoom-out` 而不是整屏统一，是因为「点图不关闭」和「点空白关闭」必须能被光标区分开，否则用户永远猜不到。

overlay **之外**的那一行是唯一一处我们写页面元素的地方，所以它被三条闸夹着：判得开才写、页面声明过的 cursor 一律让、`snapshot()` 之前必须撤销。别把它改成常驻样式表——`cursor` 是继承属性，CSS 层面的「低优先级」会打断页面的继承，进而让 D24 那类可点卡片上的手型变成放大镜（D32 的理由栏）。

---

## 7. 复制链路

```js
const blob = new Blob([buf], { type: mime });
const url  = URL.createObjectURL(blob);
const img  = new Image();
img.src = url;
await img.decode();
const canvas = document.createElement('canvas');
canvas.width = img.naturalWidth;
canvas.height = img.naturalHeight;
canvas.getContext('2d').drawImage(img, 0, 0);
const png = await new Promise(r => canvas.toBlob(r, 'image/png'));
await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
URL.revokeObjectURL(url);
```

三个要点：

- **`blob:` 是同源的**，所以跨域图片经它中转后画进 canvas 不会被污染。这是整条链路能成立的原因，也是不该直接从页面里的 `<img>` 读像素的原因。已实测（E3）。
- **blob 必须在页面里造，不能在 service worker 里造。** SW 创建的 URL 是 `blob:chrome-extension://<id>/...`，和页面不同源，`<img src>` 直接加载失败（除非把 Blob 塞进 `web_accessible_resources`，那又多一层暴露面）。正确流程是 SW 只回传 `ArrayBuffer`，由 content script 自己 `new Blob(...)` + `createObjectURL`，URL 就落在页面 origin 上。
- **瞬时激活**（transient activation）有 5 秒窗口，且不会因为 `await` 而失效。所以「点 → 取字节 → 转 PNG → 写剪贴板」是安全的，只要别在里面插用户确认弹窗。
- **canvas 有尺寸上限**（Chrome 约 16384 px/边，总面积也有上限）。所以建 canvas **之前**就先判：单边 > 16384 或面积 > 32 MP 直接放弃转码（D26）。不要指望 `toBlob` 返回 `null` 来兜底——那时像素缓冲已经分配过了，OOM 已经发生。

`⇧` + 点击走 `navigator.clipboard.writeText(url)`，不碰字节，永不失败。

**超限降级的出口。** `copyImage(media, url)` 返回 `'image' | 'address'`：像素超预算时它内部做 `copyText(url)`，调用方据此 toast `Too large to copy — address copied`。降级必须被说出来——与 5.4「失败就是缺失」同一条原则：用户手里拿到的东西变了，他得知道。

---

## 8. 保存链路

```js
const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob([buf], { type: mime }));
a.download = fileName(url, mime, nw, nh);
host.appendChild(a);   // 必须在文档里，否则 click() 在部分场景不生效
a.click();
a.remove();
setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
```

不申请 `downloads`。文件名取 URL 末段（`decodeURIComponent`，去掉 query）；没有图片扩展名时用 `image-<w>x<h>.<ext>`，`ext` 从 mime 推。

保存的是原始字节，动图仍是动图——这正是它和复制并存的原因。

---

## 9. 生命周期与清理

| 事件 | 动作 |
| --- | --- |
| `pagehide` | 关闭，释放 buffer |
| `pageshow` 且 `persisted` | 关闭（bfcache 恢复后状态已失效） |
| `resize` / `orientationchange` | 重算 `fit`；若当前正处于适应态，就保持适应态 |
| 打开时 `host.isConnected === false` | 页面换过根节点，重新挂到 `documentElement` |
| SPA 路由变化 | 不处理。overlay 留着，用户自己关 |

`boot` 在 `document_start` 运行，此时 `documentElement` 已存在、`body` 可能还没有——所以跟 DOM 有关的操作全部走「懒创建」，只在第一次打开时做。

---

## 10. MV3 的坑

| 坑 | 处理 |
| --- | --- |
| Service worker 空闲约 30 s 被终止 | 消息处理函数里 `return true` 保持通道；长流式读取期间 SW 处于活动状态，不会被回收 |
| `document_start` 时 `body` 可能不存在 | 懒创建，见第 9 节 |
| 动态注册的 content script 对**已打开**的页面无效 | 授权后由 background 向活动标签页补注入一次（已在设计里） |
| 重新注册会丢失差量之外的配置 | 每次 `sync()` 传完整对象，不做差量更新 |
| `adoptedStyleSheets` 在 isolated world 的可用性 | 构造的 `CSSStyleSheet` 归属于文档，跨 world 可用；页面 CSP 也拦不住它 |
| 页面被替换 `documentElement` | 打开时检查 `isConnected` |
| 页面规则命中 shadow host | 外层树的普通声明**优先于** shadow 树的 `:host` 声明（CSS Scoping，与特异性无关）：页面一句 `div{color:#111}` 就能把整条 `:host{...}` 盖掉，顺带还能压 `max-width`。所以宿主的定位与调色板一律写 inline（`all:initial` + 属性），见 `overlay.js` 的 `ensure()` |

---

## 11. 预算怎么测

| 预算 | 测法 |
| --- | --- |
| < 66 KB | `wc -c src/content/*.js \| tail -1`，或直接看 `tools/check-manifest.mjs` 的告警行 |
| `judge()` < 1 ms | 开发时在控制台对同一张图跑 1000 次取平均；**不写进发布代码** |
| 点击 → 首帧 < 100 ms | 同上，`performance.mark` 两次；只在本地验 |
| 加载期 3 个监听 | `e7` 数 `boot.js` + `hint.js` 的 `addEventListener`（D32 后由 2 改成 3） |

测量代码不进仓库的发布路径——第六条管的是发布产物。

---

## 12. 动手前必须先跑的三个实验

这三个都是半小时内的临时脚本，不写产品代码。任何一个失败，设计就要改。

**E1 — 让位检测的假阳性率（最关键）**

脚本已写好：`tools/probe-yield.js`。粘进 DevTools 的 Snippets 跑，然后正常点击——它只观察，不阻止任何东西，页面行为与没装任何东西时完全一致。点够 15–30 次执行 `__closer.report()`。

选点要覆盖：新闻文章、图站瀑布流、电商列表、自带查看器的图集、社交媒体时间线、有轮播的首页、纯文字博客、一个慢加载站点。

报告把每次点击归到四类之一：

| guess | 含义 | 该怎么读 |
| --- | --- | --- |
| `open-ok` | 页面没动，我们会打开 | 理想 |
| `yield-ok` | 页面动了且确实开了查看器，我们让位 | 理想 |
| `late-yield` | 我们打开了，页面**随后**才开，于是我们关掉自己 | 会闪一下；占比高说明页面的查看器挂载慢 |
| `yield-blind` | 我们让位了，但看不出页面做了什么 | 漏开，能忍；占比过高说明判据太宽 |
| `MISS` | 我们以为页面没动，其实它开了查看器 | **双开，最危险；出现就要调窄** |

`viewer` 列是代理指标（同 src 的 `<img>` 变多、或出现了 `[class*=lightbox]` 一类的层），不是判据——它只用来让人判断 `acted` 到底判对没有。

要回答的只有一句：**「页面没动」的判定，在对的站点上到底有多少是错的？**
**这一条只能实测，推不出来。**

#### 第一次实测记录（2026-10-20）

页面：阮一峰周刊第 415 期（静态博客，48 张图，无自有查看器）。视口 1513 × 936，dpr 2。

| 观察 | 结果 |
| --- | --- |
| `acted` | 5 次点击全部 `none`，`viewer` 为空 —— 与「这页没有查看器」一致 |
| 判定 | 全部 `open-ok`，无 `MISS`、无 `yield-*` |
| 非图片点击 | 点段落不产生记录；点链接正常导航（因为非候选不 `preventDefault`） |
| 阈值问题 | 150 × 150 的公众号二维码（22 500 px²）被判为候选 → 面积门槛上调到 40 000 |
| 几何问题 | 800 × 1000 的图页面画 809 × 1009，`fit` 只有 0.88 → overlay 里反而更小 |

这一页只验证了 `open-ok` 这一支（本来也只可能有这一支）。**`yield-ok` 与 `MISS` 还没在真站点上跑过**——需要找带自有查看器的页面，或者用本地造的实验页（一个固定定位的假 lightbox）来跑。

#### 实验页结果（2026-10-20，同日）

`tools/lab/index.html`，八个受控场景，全部符合期望：

| 场景 | 期望 | 实际 | acted / late / viewer |
| --- | --- | --- | --- |
| c1 纯图，无处理器 | `open-ok` | ✔ | none / - / - |
| c2 同步打开的假查看器 | `yield-ok` | ✔ | hit / - / dup-img+layer |
| c3 800 ms 后才开的查看器 | `late-yield` | ✔ | none / hit / dup-img+layer |
| c4 `cursor: zoom-in`，无处理器 | `open-ok` | ✔ | none / - / - |
| c5 图片包在商品链接里 | rule 9 | ✔ | — |
| c6 24×24 图标 | rule 2 | ✔ | — |
| c7 150×150 二维码 | rule 3 | ✔ | — |
| c8 按钮里的图 | rule 6 | ✔ | — |

由此确认三件事：

1. **让位判据成立。** 同步挂载的查看器在下一帧就被 `hit` 抓到，`dup-img` 与 `layer` 两个代理指标同时命中。
2. **删掉 `cursor: zoom-in` 是对的**（见 D10）。c4 是一个只设了光标、没有任何处理器的图，现在会被正常打开；如果当初把它当「站点有查看器」的证据，这里就会误让。
3. **c3 暴露了真实代价**：查看器挂载慢于两帧的站点，我们会先打开、再自己关掉，用户看到一次闪烁。这是 `late-yield` 的固有成本，不是 bug。判据本身没错，错的是时序上不可能更早知道。

仍未覆盖：`MISS`（真实站点上的双开）与 `target=_blank` 盲区。后者无法用合成事件复现——**不受信任的 click 不会触发默认行为**，只有真实点击才会，所以这一格只能手工点。

**E2 — 轮播与动图下 `elementFromPoint` 稳不稳**

脚本：`tools/lab/e2-drift.mjs`（自起页面、自造动效、自动采样）。

四种场景 × 两种采样点（图片正中心、距左边缘 6 px），每种连续 60 帧，比对「基线 hit」与「下一帧 hit」是否同一个元素：

| 场景 | 帧间位移 | 中心点漂移 | 边缘 6 px 漂移 |
| --- | --- | --- | --- |
| 轮播平移（400 px 往复） | 3.5 px | 0 / 60 | 0 / 60 |
| 单边放大（1.0→1.06） | 0.4 px | 0 / 60 | 0 / 60 |
| 呼吸缩放（0.96↔1.06） | 0.1 px | 0 / 60 | 0 / 60 |
| 静止对照 | 0 | 0 / 60 | 0 / 60 |

**480 次比对，0 次漂移。** 结论：

- `hit` 的「引用相等」判据对动画是稳的，**不需要**放宽成「仍是同一张图或其后代」，第 4 节那套判据原样保留。
- 原因可解释：脱靶要求「帧间位移 > 点击点到边缘的距离」。图宽 180 px、每帧移动 3.5 px，边缘 6 px 处也追得上。
- 唯一会脱靶的是**瞬间切换**（整图消失、轮播跳到下一张）。而那种时刻页面确实在动，判「动过 → 让位」是正确行为，不是误判。

**E3 — 跨域图片经 blob 中转后 canvas 是否被污染**

脚本：`tools/lab/e3-pollution.mjs`（起 8811 页面 + 8812 图片两个端口，端口不同即跨域）。

| 链路 | 结果 |
| --- | --- |
| A `<img src=跨域>` → `drawImage` → `getImageData` | **被污染**，抛 `SecurityError` |
| B `fetch → ArrayBuffer → new Blob → objectURL → drawImage` | **未污染**，`toBlob` 正常返回，首像素 `0,0,128,255` |
| C `fetch(blob:)` 回读 | 成功，3 B —— blob URL 与页面同源 |

**结论：「复制图片本身」可以做，第 7 节不必重写。** 附带确认了一条流程约束：blob 必须在页面里造，SW 只回传 `ArrayBuffer`——见第 7 节第二条。

三个实验至此全部通过，**可以开始写第一行产品代码**。

---

## 13. 文案与语言（D29）

两种语言：`en`（`default_locale`）与 `zh_CN`。语言由浏览器 UI 语言决定，代码里没有任何检测逻辑，也没有切换开关。

| 位置 | 怎么取 | 为什么 |
| --- | --- | --- |
| content（overlay） | `Closer.t(key, subs)` → `chrome.i18n.getMessage` | `chrome.i18n` 是 content script 能直接调的少数 API 之一，同步——不破坏「click → open 只隔一次 rAF」 |
| popup / welcome | `ui/i18n.js` 的 `t()` + `data-i18n` / `data-i18n-html` | HTML 不支持 `__MSG__`，只能由 JS 填；两个页面共用一份五行包装，不为它引模块系统 |
| manifest | `__MSG_appName__` / `__MSG_appDesc__` | 平台唯一支持 manifest 本地化的机制；`default_locale` 与 `_locales/` 必须同时存在，缺一边 Chrome 直接装不上 |

四条实现约束：

- **占位符必须声明**在 `placeholders` 里（`"content": "$1"`），不要在 message 里直接写 `$1`。语序不同的语言只能靠占位符对上：`Pause on $SITE$` / `在 $SITE$ 上暂停`。
- **漏 key 不报错**，`getMessage` 返回空串，界面上一块空白。所以 `Closer.t` 退回 key 本身（看得见 `copyFailed` 这种字），并由 `tools/check-i18n.mjs` 在 `verify` 阶段拦下。
- **`<strong>` / `<code>` 写在 messages.json 里**，取用时显式 `{ escapeLt: false }`，且只灌进 `data-i18n-html` 的那几段说明文字；其余文案一律 `textContent`。
- **key 必须写成字面量**：`Closer.t('copyFailed')`，不要 `Closer.t(someVar)`。`check-i18n` 靠静态扫字面量来判断「有没有引用不存在的 key」和「有没有没人引用的 key」，绕过去就等于关掉了这条检查。

`tools/check-i18n.mjs` 的断言：默认语言目录存在 → 各语言 key 集合与默认语言逐字相同 → 同一 key 的占位符跨语言相同 → 代码/manifest 引用的 key 都存在（反向也报未被引用的 key）。它不需要浏览器，所以能进 `verify`。
