import Carbon
import Foundation

/// 语言方向。`auto` 交给引擎侧的语言判定（与扩展「翻译草稿」用同一个函数）。
enum DirectionMode: String, CaseIterable {
    case auto
    case zhToEn
    case enToZh

    var title: String {
        switch self {
        case .auto: return "自动识别"
        case .zhToEn: return "中文 → 英文"
        case .enToZh: return "英文 → 中文"
        }
    }

    var from: String {
        switch self {
        case .auto: return "auto"
        case .zhToEn: return "zh"
        case .enToZh: return "en"
        }
    }

    var to: String {
        switch self {
        case .auto: return "zh"
        case .zhToEn: return "en"
        case .enToZh: return "zh"
        }
    }

    /// 需要预下载的语言包方向；自动模式下把中英双向都装上
    var preloadDirections: [String] {
        switch self {
        case .auto: return ["en-zh", "zh-en"]
        case .zhToEn: return ["zh-en"]
        case .enToZh: return ["en-zh"]
        }
    }
}

/// 一个全局热键组合。keyCode 为 0 表示未设置。
struct KeyCombo: Equatable {
    var keyCode: UInt32
    var modifiers: UInt32

    var isEnabled: Bool { keyCode != 0 }

    static let wholeFieldDefault = KeyCombo(
        keyCode: UInt32(kVK_ANSI_T),
        modifiers: UInt32(controlKey | optionKey)
    )
    static let selectionDefault = KeyCombo(
        keyCode: UInt32(kVK_ANSI_Y),
        modifiers: UInt32(controlKey | optionKey)
    )

    var description: String {
        guard isEnabled else { return "未设置" }
        var text = ""
        if modifiers & UInt32(controlKey) != 0 { text += "⌃" }
        if modifiers & UInt32(optionKey) != 0 { text += "⌥" }
        if modifiers & UInt32(shiftKey) != 0 { text += "⇧" }
        if modifiers & UInt32(cmdKey) != 0 { text += "⌘" }
        return text + Self.label(for: keyCode)
    }

    private static func label(for keyCode: UInt32) -> String {
        let letters: [UInt32: String] = [
            UInt32(kVK_ANSI_A): "A", UInt32(kVK_ANSI_B): "B", UInt32(kVK_ANSI_C): "C",
            UInt32(kVK_ANSI_D): "D", UInt32(kVK_ANSI_E): "E", UInt32(kVK_ANSI_F): "F",
            UInt32(kVK_ANSI_G): "G", UInt32(kVK_ANSI_H): "H", UInt32(kVK_ANSI_I): "I",
            UInt32(kVK_ANSI_J): "J", UInt32(kVK_ANSI_K): "K", UInt32(kVK_ANSI_L): "L",
            UInt32(kVK_ANSI_M): "M", UInt32(kVK_ANSI_N): "N", UInt32(kVK_ANSI_O): "O",
            UInt32(kVK_ANSI_P): "P", UInt32(kVK_ANSI_Q): "Q", UInt32(kVK_ANSI_R): "R",
            UInt32(kVK_ANSI_S): "S", UInt32(kVK_ANSI_T): "T", UInt32(kVK_ANSI_U): "U",
            UInt32(kVK_ANSI_V): "V", UInt32(kVK_ANSI_W): "W", UInt32(kVK_ANSI_X): "X",
            UInt32(kVK_ANSI_Y): "Y", UInt32(kVK_ANSI_Z): "Z"
        ]
        if let letter = letters[keyCode] { return letter }
        switch Int(keyCode) {
        case kVK_Space: return "空格"
        case kVK_Return: return "回车"
        default: return "键码 \(keyCode)"
        }
    }
}

/// 设置存 UserDefaults，够用且不引入额外依赖。
final class Preferences {

    static let shared = Preferences()

    private let defaults = UserDefaults.standard

    private enum Key {
        static let direction = "direction"
        static let wholeFieldHotKey = "hotKey.wholeField"
        static let selectionHotKey = "hotKey.selection"
        static let maxCharacters = "maxCharacters"
        static let showsInDock = "showsInDock"
        static let hidesWelcome = "hidesWelcome"
    }

    /// 输入框内容超过这个长度就拒绝翻译：草稿里整篇贴进来的情况很常见，
    /// 送进模型只会卡住，不如直接告诉用户。
    var maxCharacters: Int {
        get { defaults.object(forKey: Key.maxCharacters) as? Int ?? 2000 }
        set { defaults.set(newValue, forKey: Key.maxCharacters) }
    }

    var direction: DirectionMode {
        get { DirectionMode(rawValue: defaults.string(forKey: Key.direction) ?? "") ?? .auto }
        set { defaults.set(newValue.rawValue, forKey: Key.direction) }
    }

    var wholeFieldHotKey: KeyCombo {
        get { combo(forKey: Key.wholeFieldHotKey) ?? .wholeFieldDefault }
        set { setCombo(newValue, forKey: Key.wholeFieldHotKey) }
    }

    var selectionHotKey: KeyCombo {
        get { combo(forKey: Key.selectionHotKey) ?? .selectionDefault }
        set { setCombo(newValue, forKey: Key.selectionHotKey) }
    }

    /// 要不要占一个程序坞图标。**默认占**：菜单栏挤的时候系统会把状态项整个挤掉，
    /// 那时「译」根本不在屏幕上，程序坞图标就是唯一还看得见的入口。
    /// 嫌它乱可以在菜单里关掉。
    var showsInDock: Bool {
        get { defaults.object(forKey: Key.showsInDock) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.showsInDock) }
    }

    /// 用户勾过「启动时不再提示」之后，启动就不再弹说明；
    /// 但手动再点一次 App 时仍然要弹（那是他主动在找入口）。
    var hidesWelcome: Bool {
        get { defaults.bool(forKey: Key.hidesWelcome) }
        set { defaults.set(newValue, forKey: Key.hidesWelcome) }
    }

    private func combo(forKey key: String) -> KeyCombo? {
        guard let stored = defaults.dictionary(forKey: key),
              let keyCode = stored["keyCode"] as? Int,
              let modifiers = stored["modifiers"] as? Int else { return nil }
        return KeyCombo(keyCode: UInt32(keyCode), modifiers: UInt32(modifiers))
    }

    private func setCombo(_ combo: KeyCombo, forKey key: String) {
        defaults.set(["keyCode": Int(combo.keyCode), "modifiers": Int(combo.modifiers)], forKey: key)
    }
}
