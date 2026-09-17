import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const macosRoot = join(root, 'macos');
const sourcesRoot = join(macosRoot, 'Sources/TranslateAssistant');
const extensionLib = join(root, 'extension', 'lib');
const buildScript = readFileSync(join(root, 'scripts/build-macos.mjs'), 'utf8');

function read(relative) {
  return readFileSync(join(root, relative), 'utf8');
}

function relativeImports(file) {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)].map(match => match[1]);
}

/** 从构建脚本里解出「要拷进 App 包的引擎模块」清单 */
function copiedModules() {
  const match = buildScript.match(/const needed = \[([^\]]+)\]/);
  assert.ok(match, '构建脚本里找不到 needed 清单');
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
}

test('macOS 端不 fork 引擎，源码只有一份', () => {
  const forked = [
    'macos/lib',
    'macos/vendor',
    'macos/web/lib',
    'macos/web/vendor',
    'macos/Sources/TranslateAssistant/engine.js',
    'macos/Sources/TranslateAssistant/engine.swift'
  ];
  for (const path of forked) {
    assert.ok(!existsSync(join(root, path)), `${path} 不该存在：引擎由构建脚本从 extension/ 拷入，避免两份实现漂移`);
  }
  assert.ok(existsSync(join(extensionLib, 'engine.js')), '引擎本体应当在 extension/lib 下');
});

test('构建脚本拷贝的模块覆盖引擎的依赖闭包', () => {
  const copied = new Set(copiedModules());
  const required = new Set();

  for (const entry of ['engine.js', 'protocol.js']) {
    for (const spec of relativeImports(join(extensionLib, entry))) {
      const resolved = resolve(extensionLib, spec);
      // vendor 整个目录都会拷，不用逐个登记
      if (resolved.split(sep).includes('vendor')) continue;
      required.add(basename(resolved));
    }
  }

  for (const name of required) {
    assert.ok(copied.has(name), `构建脚本没有拷贝 ${name}，macOS 端会 import 失败`);
  }
  for (const name of copied) {
    assert.ok(existsSync(join(extensionLib, name)), `extension/lib/${name} 不存在`);
  }
});

test('垫片用 defineProperty 覆盖全局对象', () => {
  const shims = read('macos/web/shims.js');

  // `caches` 在 Window 上是个只有 getter 的访问器属性：直接赋值在严格模式下抛
  // TypeError，垫片静默失效，浏览器自带的 Cache Storage 顶上，缓存不会落到本机目录。
  assert.doesNotMatch(shims, /globalThis\.caches\s*=/, '禁止直接给 caches 赋值');
  assert.doesNotMatch(shims, /globalThis\.chrome\s*=/, '禁止直接给 chrome 赋值');
  assert.doesNotMatch(shims, /globalThis\.fetch\s*=/, '禁止直接给 fetch 赋值');
  assert.match(shims, /Object\.defineProperty\(globalThis, name/);

  for (const name of ['chrome', 'fetch', 'caches']) {
    assert.match(shims, new RegExp(`override\\('${name}'`), `垫片缺少 ${name}覆写`);
  }

  // 垫片失败要能被宿主看见，否则问题只会表现为「缓存莫名其妙不生效」
  assert.match(shims, /__ltShimFailures/);
});

test('宿主页面在 module 脚本之前加载垫片', () => {
  const html = read('macos/web/engine.html');
  const shimAt = html.indexOf('src="/shims.js"');
  const moduleAt = html.indexOf('type="module"');
  assert.ok(shimAt > 0, 'engine.html 应当引入 shims.js');
  assert.ok(moduleAt > 0, 'engine.html 应当有 module 脚本');
  assert.ok(shimAt < moduleAt, '垫片必须先于 module 执行，否则引擎已经 import 完，垫片来不及生效');
});

test('引擎服务以 application/wasm 提供 WASM', () => {
  const server = readFileSync(join(sourcesRoot, 'EngineServer.swift'), 'utf8');
  // MIME 写错的话 WebAssembly.instantiateStreaming 会直接拒绝加载
  assert.match(server, /case "wasm": return "application\/wasm"/);
});

test('语言包代理显式要求 identity 编码', () => {
  const server = readFileSync(join(sourcesRoot, 'EngineServer.swift'), 'utf8');
  // URLSession 默认会自动解压，而 Content-Length 仍是压缩前的值，
  // 页面上的下载进度（「下载模型… 21.9 / 29.1 MB」）会算错
  assert.match(server, /setValue\("identity", forHTTPHeaderField: "Accept-Encoding"\)/);
});

test('回环服务只监听本机，且响应后关闭连接', () => {
  const server = readFileSync(join(sourcesRoot, 'EngineServer.swift'), 'utf8');
  const transport = readFileSync(join(sourcesRoot, 'HTTPServer.swift'), 'utf8');
  assert.match(server, /requiredInterfaceType = \.loopback/, '引擎服务不应对外暴露');
  assert.match(transport, /merged\["Connection"\] = "close"/);
});

test('Info.plist 是菜单栏应用，且 bundle id 与签名一致', () => {
  const plist = read('macos/Resources/Info.plist');
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/, '需要 LSUIElement：不占 Dock、不抢焦点');

  const identifier = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.ok(identifier, 'Info.plist 缺少 CFBundleIdentifier');
  // TCC（辅助功能授权）按 bundle id + 签名认应用，两边不一致会导致「授权了却用不了」
  assert.ok(buildScript.includes(`'${identifier}'`), `签名 identifier 必须与 Info.plist 的 ${identifier} 一致`);
});

test('构建脚本在受限环境里关掉 SwiftPM 沙箱', () => {
  // 本机只有 Command Line Tools 时，SwiftPM 自己的 sandbox-exec 会
  // sandbox_apply: Operation not permitted，必须显式 --disable-sandbox
  assert.match(buildScript, /'build', '--disable-sandbox'/);
});

test('macOS 文档说明了重新构建后要重新授权', () => {
  const readme = read('macos/README.md');
  assert.match(readme, /ad-hoc/);
  assert.match(readme, /辅助功能/);
  assert.match(readme, /重新授权|重新授权|重新勾选|重新添加/, '必须写清 ad-hoc 签名导致权限失效这个坑');
});

test('浏览器扩展的构建与发版完全不牵涉 macOS 端', () => {
  // 扩展是跨平台的（Windows / macOS / Linux 上都是同一份前端代码），
  // macOS 端是附加目标。两边的构建、测试、发版必须互不牵连，
  // 否则非 macOS 用户会被一个他用不上的目标拖累。
  //
  // 判据是「有没有引用 macOS 端的目录或构建入口」，而不是「有没有出现过 macos 这个词」：
  // build.mjs 里有一句「macOS 上没有 zip 时退回 ditto」，那是正当提及，不是耦合。
  for (const name of ['build.mjs', 'release.mjs', 'verify-engine.mjs']) {
    const source = read(`scripts/${name}`);
    assert.doesNotMatch(source, /macos[\\/]/i, `${name} 不该引用 macOS 端的目录`);
    assert.doesNotMatch(source, /build-macos|TranslateAssistant\.app/, `${name} 不该触发 macOS 端的构建`);
  }

  // 发版只附带扩展那一个 zip
  const release = read('scripts/release.mjs');
  assert.match(release, /translate-assistant-v\$\{next\}\.zip/);
  assert.doesNotMatch(release, /\.dmg/);
});

test('macOS 构建脚本在非 macOS 平台上明确拒绝，而不是抛 ENOENT', () => {
  assert.match(read('scripts/build-macos.mjs'), /process\.platform !== 'darwin'/);
});

test('macOS 单测不执行外部命令，非 macOS 平台也能跑', () => {
  // 这些断言只读文件内容。一旦有人在这里跑 swift / xcrun，
  // Windows 与 Linux 上的 npm test 就会挂 —— 而 npm test 是发版流程的一环
  // （release.mjs 会跑它），影响面不止 macOS 用户。
  const spawn = 'child' + '_process';
  const source = read('tests/unit/macos.test.mjs');
  assert.ok(!source.includes(spawn), `macOS 单测不应引入 ${spawn}`);
});

test('package.json 暴露 macOS 构建命令', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['build:macos'], '缺少 build:macos 脚本');
  assert.match(pkg.scripts['build:macos'], /build-macos\.mjs/);
});

test('入口不可见有兜底：再开一次要有反馈，并且能切到程序坞', () => {
  // 菜单栏程序（LSUIElement）启动后屏幕上什么都不会多出来。用户去访达里双击 App 时，
  // 系统只是把已经在跑的实例激活，看起来就是「双击没反应」。
  // 这两条是「让用户找得到入口」的最小集合，别再弄丢。
  const delegate = read('macos/Sources/TranslateAssistant/AppDelegate.swift');
  assert.match(delegate, /applicationShouldHandleReopen/, '再次打开 App 必须有可见反馈');
  assert.match(delegate, /setActivationPolicy/, '菜单栏挤掉状态项时要能切到程序坞');
  assert.match(read('macos/Sources/TranslateAssistant/Preferences.swift'), /showsInDock/);
});

test('宿主页面引入的引擎模块都在构建脚本的拷贝清单里', () => {
  // 这条盯的是「改了引擎、App 里还是旧的」这类问题：macos/web/lib 在源码树里
  // 并不存在，全靠 assembleWeb 从 extension/lib 拷进去。导入清单和拷贝清单一旦
  // 不一致，App 打包后在页面上是个 404，而源码和单测都看不出任何异常。
  const copied = new Set(copiedModules());
  const html = read('macos/web/engine.html');
  const imported = [...html.matchAll(/from\s+'\/lib\/([^']+)'/g)].map(match => match[1]);

  assert.ok(imported.length > 0, 'engine.html 应当从 /lib/ 引入引擎模块');
  for (const name of imported) {
    assert.ok(copied.has(name), `engine.html 引入了 /lib/${name}，但构建脚本不会拷贝它`);
  }
});

test('输入框旁的浮标不抢焦点', () => {
  // 浮标是盖在对方输入框上的我方面板。一旦它把前台应用切走，原来的输入框就
  // 不再是焦点，点完按钮反而找不到回填的落脚点 —— 所以「不激活」是硬约束。
  const pill = read('macos/Sources/TranslateAssistant/InlinePill.swift');
  assert.match(pill, /\.nonactivatingPanel/);
  assert.match(pill, /override var canBecomeKey: Bool \{ false \}/);
  assert.match(pill, /orderFrontRegardless/);
  assert.doesNotMatch(pill, /makeKeyAndOrderFront/, '显示浮标不能顺带抢走键盘焦点');
  assert.doesNotMatch(pill, /NSApp\.activate|\.activate\(/, '浮标不该激活本 App');
});

test('浮标点击用的是它旁边那个输入框，不是「此刻的系统焦点」', () => {
  // 用户点浮标时手已经离开键盘，若再去问一次系统焦点就会翻错对象。
  const delegate = read('macos/Sources/TranslateAssistant/AppDelegate.swift');
  assert.match(delegate, /Accessibility\.snapshot\(of: /, '应当按浮标记住的控件取内容');
  assert.match(delegate, /private var pillTarget/);
});

test('跟随光标只读坐标，不读草稿内容', () => {
  // 定位路径每 0.25 秒跑一次，顺手把用户的草稿读一遍既没必要也不礼貌。
  // 允许查「这个控件能不能写」（那是判断能不能输入），不允许把内容取出来。
  const source = readFileSync(join(sourcesRoot, 'Accessibility.swift'), 'utf8');
  const start = source.indexOf('static func focusedFieldGeometry');
  const end = source.indexOf('appKitRect(fromAX', start);
  assert.ok(start > 0 && end > start, '找不到 focusedFieldGeometry');

  const geometryPath = source.slice(start, end);
  assert.doesNotMatch(geometryPath, /string\(element, kAXValueAttribute\)/);
  assert.doesNotMatch(geometryPath, /string\(element, kAXSelectedTextAttribute\)/);
  assert.match(source, /AXUIElementSetMessagingTimeout/, '反向查询要设超时，否则目标应用一忙就把我们的主线程拖住');
});

test('跟随光标既有通知也有轮询兜底', () => {
  // 有的应用不发焦点变化通知；而窗口被拖动、页面被滚动时焦点并没有「变化」，
  // 位置却变了，那种情况只能靠重新读一次坐标发现 —— 两条都要在。
  const tracker = read('macos/Sources/TranslateAssistant/FocusTracker.swift');
  assert.match(tracker, /kAXFocusedUIElementChangedNotification/);
  assert.match(tracker, /didActivateApplicationNotification/, '前台换人时要换监听对象');
  assert.match(tracker, /Timer\.scheduledTimer/);
});

test('结果浮层贴着输入框摆，且引用历史会先提醒', () => {
  const hud = read('macos/Sources/TranslateAssistant/HUDWindow.swift');
  // 邮件回复框常常占掉大半个屏幕，只贴着「下方」摆是放不下的
  for (const direction of ['下方', '上方', '右侧', '左侧']) {
    assert.ok(hud.includes(direction), `贴边摆放应当考虑${direction}`);
  }

  const delegate = read('macos/Sources/TranslateAssistant/AppDelegate.swift');
  assert.match(delegate, /quotedHistoryWarning/, '草稿含引用历史时要提醒「填入会整框替换」');
});

test('浮标有开关，能在菜单里关掉', () => {
  assert.match(read('macos/Sources/TranslateAssistant/Preferences.swift'), /var inlinePill: Bool/);
  const delegate = read('macos/Sources/TranslateAssistant/AppDelegate.swift');
  assert.match(delegate, /menuTogglePill/);
  // 默认必须是开的：热键是「知道有这功能才用得上」的入口，浮标是看得见的入口
  assert.match(read('macos/Sources/TranslateAssistant/Preferences.swift'), /Key\.inlinePill\) as\? Bool \?\? true/);
});

// ↓↓↓ 读「选中的文字」这条路

function selectionSource() {
  return read('macos/Sources/TranslateAssistant/Selection.swift');
}

/** 抠出某个函数的完整函数体：从它的声明到下一个同缩进的函数声明为止 */
function functionBody(source, name) {
  const start = source.indexOf(`private static func ${name}`);
  assert.ok(start > 0, `找不到 ${name}`);
  const next = source.indexOf('\n    private static func ', start + 10);
  return source.slice(start, next > 0 ? next : source.length);
}

test('读选区有三条通道，且按副作用从小到大排', () => {
  // 网页里的选区跟「输入框」不是一回事：AX 属性读不到时必须还有后手，
  // 否则「翻译选中文字」在邮件、网页里直接失效。
  const source = selectionSource();
  for (const channel of ['case accessibility', 'case menu', 'case keystroke']) {
    assert.ok(source.includes(channel), `Selection.Source 缺少 ${channel}`);
  }

  const order = ['readViaAttributes(pid:', 'findMenuItem(inApp: pid, command: "C"', 'copyViaKeystroke(pid:'];
  const positions = order.map(needle => {
    const at = source.indexOf(needle);
    assert.ok(at > 0, `找不到 ${needle}`);
    return at;
  });
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, '通道顺序必须是「先 AX、再菜单、最后合成按键」');
});

test('AX 那条通道只认真正的文本控件', () => {
  // 实测：同一段选区，Chromium 在网页容器（AXWebArea）上时有时无，
  // 报出来时还会把换行和制表符压平（下单⇥03 变成 下单03）；AXTextArea 每次都准。
  const source = selectionSource();
  for (const role of ['kAXTextAreaRole', 'kAXTextFieldRole', 'kAXComboBoxRole']) {
    assert.ok(source.includes(role), `可编辑文本控件清单里少了 ${role}`);
  }
  const start = source.indexOf('private static func selectedText(of element: AXUIElement)');
  const end = source.indexOf('private static func isEditableTextRole', start);
  assert.ok(start > 0 && end > start, '找不到 selectedText');
  assert.match(source.slice(start, end), /guard isEditableTextRole\(element\) else \{ return nil \}/);
});

test('借来的剪贴板必须还回去', () => {
  // 走菜单项/合成按键那两条通道要借用剪贴板。用户的剪贴板不该因为读一段文字就没了。
  const source = selectionSource();
  assert.match(source, /private static func savePasteboard/);
  assert.match(source, /private static func restorePasteboard/);

  for (const name of ['copyViaMenuItem', 'copyViaKeystroke']) {
    const body = functionBody(source, name);
    assert.match(body, /savePasteboard\(\)/, `${name} 用之前没存剪贴板`);
    assert.match(body, /restorePasteboard\(saved\)/, `${name} 用完没还剪贴板`);
  }
});

test('终端类应用绝不替用户发合成按键', () => {
  // 这些应用里 ⌘C / ⌘V 常被绑成「把控制字符打进终端」，
  // 替用户按一下等于往他的 shell 里塞一个中断 —— 宁可失败也不能干。
  const source = selectionSource();
  assert.match(source, /keystrokeUnsafeBundleIDs/);
  for (const id of ['com.apple.Terminal', 'com.googlecode.iterm2']) {
    assert.ok(source.includes(id), `终端拒绝名单里少了 ${id}`);
  }
  assert.match(source, /private static func keystrokeRefusal/);
});

test('菜单项按键位找，不靠标题', () => {
  // 中英文界面的标题不一样，快捷键却一样。而且 Chrome 里 cmd=C 的项有三个，
  // 「窗口 › 居中」和「检查元素」都带 C，只靠字母分不开，要靠修饰键掩码。
  const source = selectionSource();
  assert.match(source, /AXMenuItemCmdChar/);
  assert.match(source, /AXMenuItemCmdModifiers/);
  assert.match(source, /kAXMenuItemRole/);
  assert.match(source, /if mods == 0 \{ exact = exact \?\? item \}/);
});

test('只读的位置不假装回填成功', () => {
  // 邮件阅读窗格、网页正文都是只读的，译文粘不进去。这时要直说，
  // 并且把译文留在剪贴板里 —— 那是用户此刻唯一能拿到的成果。
  const source = selectionSource();
  const start = source.indexOf('if targetKind(pid: pid) == .readOnly');
  assert.ok(start > 0, '找不到只读分支');
  const end = source.indexOf('let saved = savePasteboard()', start);
  assert.ok(end > start, '只读分支应当在借用剪贴板之前就返回');

  const branch = source.slice(start, end);
  assert.match(branch, /ok: false/);
  assert.match(branch, /译文已经放进剪贴板/);
  assert.doesNotMatch(branch, /restorePasteboard/, '只读时不能把译文从剪贴板里收回去');
});

test('「翻译选中文字」不要求先有一个焦点输入框', () => {
  // 选区可能压根不在输入框里（阅读窗格就是只读的），
  // 所以这条路不能复用「读当前输入框」的实现。
  const delegate = read('macos/Sources/TranslateAssistant/AppDelegate.swift');
  assert.match(delegate, /private func beginSelection\(\)/);
  assert.match(delegate, /let result = Selection\.read\(\)/);
  assert.match(delegate, /case \.selection:\s*\n\s*beginSelection\(\)/);

  const start = delegate.indexOf('private func beginSelection()');
  const end = delegate.indexOf('private func beginWholeField', start);
  const body = delegate.slice(start, end);
  assert.doesNotMatch(body, /Accessibility\.snapshot/, '选中模式不该再去读输入框');
  assert.match(body, /Selection\.read\(\)/);
});

test('选中模式回填不做整框覆写', () => {
  // 整框覆写会把用户没选中的部分一起冲掉。
  const delegate = read('macos/Sources/TranslateAssistant/AppDelegate.swift');
  const start = delegate.indexOf('private func fillBack()');
  const end = delegate.indexOf('private func finishFill', start);
  const body = delegate.slice(start, end);
  assert.match(body, /Selection\.replace\(text, in: capture\)/);
  assert.doesNotMatch(body, /Accessibility\.write\(text, into: snapshot, preferring: \.selectedText\)/);
});

test('选中翻译带一个能自证的诊断入口', () => {
  // 用户报「选中翻译没反应」时，一句话说不清是权限、菜单还是按键的问题。
  const entry = read('macos/Sources/TranslateAssistant/Entry.swift');
  assert.match(entry, /--check-selection/);
  assert.match(entry, /Selection\.diagnostics\(target: target\)/);

  // 诊断默认看「前台应用」，而它本身要在终端里敲 —— 那时前台正是终端，
  // 所以要能指定 pid，否则这份诊断根本查不到出问题的那个 App。
  assert.match(read('macos/Sources/TranslateAssistant/Paths.swift'), /var selectionPid: pid_t\?/);
  assert.match(entry, /LaunchOptions\.selectionPid/);
  assert.match(read('macos/README.md'), /--selection-pid/);
});

test('macOS 文档说清了选区这条路的三条通道', () => {
  const readme = read('macos/README.md');
  // 网页里的选区读不到是平台事实，必须写在文档里，否则用户只会以为功能坏了
  assert.match(readme, /翻译选中文字/);
  assert.ok(readme.includes('菜单项'), 'README 应当说明菜单项这条通道');
  assert.ok(readme.includes('只读'), 'README 应当说明只读位置填不回去');
  assert.match(readme, /Selection\.swift/);
});

