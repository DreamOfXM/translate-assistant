import Carbon
import Foundation

/**
 全局热键。用 Carbon 的 RegisterEventHotKey —— 它是唯一不需要辅助功能授权、
 也不需要 Input Monitoring 权限的系统级热键接口。用 NSEvent 全局监听反而要授权，
 而那时候用户可能就是因为没授权才按不动热键，会绕成一个死结。
 */
final class HotKeyCenter {

    static let shared = HotKeyCenter()

    private var handlers: [UInt32: () -> Void] = [:]
    private var registrations: [EventHotKeyRef] = []
    private var eventHandler: EventHandlerRef?
    private var nextIdentifier: UInt32 = 1

    private init() {}

    /// 安装一次事件处理器，之后 register 只挂具体的热键
    private func installHandlerIfNeeded() {
        guard eventHandler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            guard let event else { return OSStatus(eventNotHandledErr) }
            var identifier = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &identifier
            )
            guard status == noErr else { return status }
            // Carbon 回调在事件线程上，界面操作统一切回主线程
            DispatchQueue.main.async { HotKeyCenter.shared.fire(identifier.id) }
            return noErr
        }, 1, &spec, nil, &eventHandler)
    }

    fileprivate func fire(_ identifier: UInt32) {
        handlers[identifier]?()
    }

    @discardableResult
    func register(_ combo: KeyCombo, handler: @escaping () -> Void) -> Bool {
        guard combo.isEnabled else { return false }
        installHandlerIfNeeded()

        let identifier = nextIdentifier
        nextIdentifier += 1

        var reference: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: OSType(0x54524C4E), id: identifier) // 'TRLN'
        let status = RegisterEventHotKey(
            combo.keyCode,
            combo.modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &reference
        )
        guard status == noErr, let reference else { return false }

        registrations.append(reference)
        handlers[identifier] = handler
        return true
    }

    func unregisterAll() {
        for reference in registrations { UnregisterEventHotKey(reference) }
        registrations.removeAll()
        handlers.removeAll()
    }
}
