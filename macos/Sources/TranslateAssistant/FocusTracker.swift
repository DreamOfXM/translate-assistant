import AppKit
import ApplicationServices

/**
 跟着光标走：弄清楚「前台 App 现在有没有把焦点放在一个可输入的框里，那个框在屏幕的哪个位置」。

 输入框旁常驻的小浮标靠它决定出现、挪动、消失。两个来源：

 - `AXObserver` 的 `kAXFocusedUIElementChangedNotification`——真正的焦点变化，零延迟。
 - 定时轮询——兜底。有的应用不发这条通知；更要紧的是**窗口被拖动、页面被滚动时
   焦点并没有「变化」，位置却变了**，那种情况只能靠重新读一次坐标发现。

 全程只读，而且只读坐标。之所以不读内容，见 `Accessibility.FieldGeometry` 的说明。
 */
@MainActor
final class FocusTracker {

    /// 位置变化时回调；焦点离开输入框、或前台换成了别的程序时回调 `nil`
    var onChange: ((Accessibility.FieldGeometry?) -> Void)?

    /// 浮标可见时把轮询调密一点，否则跟着窗口跑会明显滞后。
    /// 不可见时没必要勤问，省电。
    var quickPoll: Bool = false {
        didSet {
            guard quickPoll != oldValue, timer != nil else { return }
            startTimer()
        }
    }

    private var observer: AXObserver?
    private var observedPid: pid_t?
    private var timer: Timer?
    private var activationToken: NSObjectProtocol?

    private var lastElement: AXUIElement?
    private var lastFrame: CGRect?

    private var interval: TimeInterval { quickPoll ? 0.25 : 1.0 }

    // MARK: - 生命周期

    func start() {
        ltTrace("start：授权=\(Accessibility.isTrusted) inlinePill 才走到这里")
        guard Accessibility.isTrusted else { return }

        // 前台换人就换监听对象：AXObserver 是绑在具体进程上的
        activationToken = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.retarget() }
        }

        retarget()
        startTimer()
    }

    func stop() {
        if let token = activationToken {
            NSWorkspace.shared.notificationCenter.removeObserver(token)
            activationToken = nil
        }
        timer?.invalidate()
        timer = nil
        detachObserver()
        lastElement = nil
        lastFrame = nil
    }

    /// 授权是用户后勾的，勾上之前 `start()` 会直接返回，所以授权生效后要再叫一次
    func restart() {
        stop()
        start()
    }

    // MARK: - 监听

    private func retarget() {
        guard let front = NSWorkspace.shared.frontmostApplication else { return }
        let pid = front.processIdentifier
        guard pid != observedPid else { return }

        detachObserver()
        observedPid = pid
        // 自己当前台时不跟：那是我们自己的弹窗，没有意义
        guard pid != getpid() else { return }

        var observer: AXObserver?
        guard AXObserverCreate(pid, focusObserverCallback, &observer) == .success,
              let observer else {
            ltTrace("retarget pid=\(pid)：AXObserverCreate 失败")
            return
        }
        let appElement = AXUIElementCreateApplication(pid)
        let added = AXObserverAddNotification(
            observer,
            appElement,
            kAXFocusedUIElementChangedNotification as CFString,
            Unmanaged.passUnretained(self).toOpaque()
        )
        ltTrace("retarget pid=\(pid)：加通知=\(added.rawValue)")
        guard added == .success else { return }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
        self.observer = observer
    }

    private func detachObserver() {
        guard let observer, let observedPid else { return }
        let appElement = AXUIElementCreateApplication(observedPid)
        AXObserverRemoveNotification(observer, appElement, kAXFocusedUIElementChangedNotification as CFString)
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
        self.observer = nil
        self.observedPid = nil
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.evaluate() }
        }
    }

    // MARK: - 判定

    fileprivate func evaluate() {
        guard Accessibility.isTrusted else {
            ltTrace("evaluate：未授权")
            publish(nil)
            return
        }
        guard let front = NSWorkspace.shared.frontmostApplication,
              front.processIdentifier != getpid() else {
            ltTrace("evaluate：前台是自己/取不到，跳过")
            publish(nil)
            return
        }

        guard let geometry = Accessibility.focusedFieldGeometry(inApp: front.processIdentifier) else {
            ltTrace("evaluate：前台=\(front.localizedName ?? "?")，没找到可输入控件")
            publish(nil)
            return
        }

        // 同一个控件、同一个位置就什么都不做——否则每 0.25 秒都会让宿主重画窗口
        let sameElement = lastElement.map { CFEqual($0, geometry.element) } ?? false
        if sameElement, lastFrame == geometry.frame {
            ltTrace("evaluate：几何未变，跳过 \(geometry.frame)")
            return
        }

        ltTrace("evaluate：命中 \(front.localizedName ?? "?") role=\(geometry.role ?? "?") frame=\(geometry.frame)")
        lastElement = geometry.element
        lastFrame = geometry.frame
        onChange?(geometry)
    }

    private func publish(_ geometry: Accessibility.FieldGeometry?) {
        guard lastElement != nil || lastFrame != nil else { return }
        lastElement = nil
        lastFrame = nil
        onChange?(geometry)
    }
}

/// `AXObserverCreate` 要的是 C 函数指针，所以这里不能捕获任何上下文；
/// 靠 `refcon` 把 tracker 递回来。通知是投递到注册时那个 runloop 的，
/// 也就是主线程，但仍然走一次 `@MainActor` 跳转，不靠「它本来就在主线程」的假设。
private let focusObserverCallback: AXObserverCallback = { _, _, _, refcon in
    guard let refcon else { return }
    let tracker = Unmanaged<FocusTracker>.fromOpaque(refcon).takeUnretainedValue()
    Task { @MainActor in tracker.evaluate() }
}
