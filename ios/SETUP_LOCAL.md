# CCMMobileMVP 本地安装与真机调试

本文档给不会 iOS 的同学，按步骤照做即可。

## 0) 前置条件

1. macOS 已安装 Xcode（建议最新稳定版）。
2. 有可用 Apple ID，并已在 Xcode 登录。
3. 本机已启动 `claude-code-manager` 后端（默认 `http://<你的电脑IP>:3000`）。
4. 后端若启用认证，准备好 `.env` 中的 `ACCESS_TOKEN`。

## 1) 打开工程

1. 在 Finder 进入仓库：`ios/`
2. 双击打开：`CCMMobileMVP.xcodeproj`
3. 左侧选中工程 `CCMMobileMVP`，确认 Target 也是 `CCMMobileMVP`。

## 2) Signing & Capabilities 配置（必须）

1. Xcode 顶部选择 Target `CCMMobileMVP`。
2. 打开 `Signing & Capabilities`。
3. 勾选 `Automatically manage signing`。
4. `Team` 选择你的 Apple ID 团队（个人账号也可以）。
5. 修改 `Bundle Identifier` 为你自己的唯一值，例如：
   - `com.<你的名字>.CCMMobileMVP`
6. 改完后等待 Xcode 自动生成签名。

如果这里报错：
- `No signing certificate`：在 Xcode -> Settings -> Accounts 中重新登录 Apple ID。
- `Bundle identifier already in use`：把 Bundle ID 再改一个唯一值。

## 3) 真机准备

1. iPhone 连接 Mac（数据线）。
2. iPhone 打开 `设置 -> 隐私与安全性 -> 开发者模式`，开启并重启手机。
3. 重启后再次确认开发者模式已启用。
4. 首次安装后，手机若提示不受信任：
   - `设置 -> 通用 -> VPN与设备管理 -> 开发者App`，点信任。

## 4) 运行到真机

1. Xcode 顶部设备列表选择你的 iPhone（不是模拟器）。
2. 点左上角 `Run`（三角按钮）。
3. 首次会较慢，等待编译和安装完成。

## 5) App 内填写 Server URL / ACCESS_TOKEN

打开 App 后：

1. `Server URL` 填后端地址，例如：
   - 同机模拟器：`http://127.0.0.1:3000`
   - 真机访问电脑：`http://<Mac局域网IP>:3000`（例如 `http://192.168.1.20:3000`）
2. `CCM ACCESS_TOKEN` 填后端 `.env` 的 `ACCESS_TOKEN`（若后端未开启认证可留空）。
3. 点击 `Save & Sync`。
4. 成功后会看到项目和任务统计。

注意：token 会存到 iOS Keychain，不会写死在代码里。

## 6) 常见报错排查

### A. 签名相关

- 报错 `Signing for "CCMMobileMVP" requires a development team`：
  - 回到 `Signing & Capabilities`，设置 Team。
- 报错证书/描述文件问题：
  - 重新登录 Apple ID，保持自动签名开启。

### B. ATS / HTTP 相关

- 报错提示不安全连接（ATS）：
  - 当前工程已在 `Info.plist` 放开 ATS（`NSAllowsArbitraryLoads = YES`）。
  - 若你手动改过 plist，请恢复该配置。

### C. 连不上 `:3000`

1. 确认后端服务已启动并监听 `3000`。
2. 真机和 Mac 必须在同一局域网。
3. 不要用 `127.0.0.1` 给真机连电脑后端，真机应使用 Mac 的局域网 IP。
4. 检查 Mac 防火墙是否拦截 Node 进程。
5. 若后端开了 `ACCESS_TOKEN`，App 里必须填同一个 token。

## 7) 推荐自检清单

1. 能在 Xcode 成功编译并安装到真机。
2. 打开 App 后 `Save & Sync` 成功。
3. 可看到 Projects/Tasks 数据。
4. 切换 Project Filter 后任务列表会刷新。
