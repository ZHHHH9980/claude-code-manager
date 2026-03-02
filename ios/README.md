# iOS MVP Notes

本目录用于 `CCMMobileMVP` 本地 iOS MVP。

## 目录结构

- `CCMMobileMVP.xcodeproj`: 可直接在 Xcode 打开的工程
- `CCMMobileMVP/`: SwiftUI 源码与 `Info.plist`
- `SETUP_LOCAL.md`: 面向本机调试和真机安装的详细步骤

## 网络与安全

MVP 默认支持连接内网 HTTP 服务（例如 `http://192.168.x.x:3000`）：

- 已在 `CCMMobileMVP/Info.plist` 添加 ATS 配置：
  - `NSAppTransportSecurity > NSAllowsArbitraryLoads = YES`
- 请仅用于本地开发调试，正式发布前建议收紧 ATS 策略并切换 HTTPS。

## 认证约束

- 不在 iOS 代码中写入任何 provider API key
- 仅使用 `CCM ACCESS_TOKEN`
- token 仅保存到 iOS Keychain（见 `KeychainStore.swift`）
