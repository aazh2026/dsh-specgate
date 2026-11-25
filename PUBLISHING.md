# 发布 `dsh-specgate` 到 npm —— 需要你本人操作的一步

## 现状

- 代码、测试、文档、GitHub 仓库、Release、tarball **全部就绪**
- 插件已在真实 DSH 里端到端验证通过
- 唯一没做完的是**推上 npmjs**

## 为什么需要你

npm 账号 `aazh2026pkg` 开启了 `auth-and-writes` 模式。`npm publish` 要求一次
one-time password，认证页在 `https://www.npmjs.com/auth/cli/<uuid>`，会强制
跳到 `https://www.npmjs.com/escalate/webauthn`，那里需要**你的安全钥匙**
（WebAuthn）。

我在自动化浏览器里能走到这一步，但 Cloudflare Turnstile 的真人验证挡在前面，
headless 环境过不去。这一步必须你本人在日常 Chrome 里做。

## 你要做的（三分钟）

1. 打开终端，进到插件目录：

   ```bash
   cd /Users/openclaw/projects/dsh-specgate
   npm publish --access public --registry https://registry.npmjs.org/
   ```

2. 它会打印一个形如这样的链接：

   ```
   npm error code EOTP
   npm error Open this URL in your browser to authenticate:
   npm error   https://www.npmjs.com/auth/cli/<uuid>
   ```

3. **在日常 Chrome 里打开那个链接**（不是自动化浏览器），用安全钥匙完成验证。

4. 回到终端，npm 会提示：

   ```
   After authenticating, your token can be retrieved from:
     https://www.npmjs.com/-/v1/done?authId=<uuid>
   ```

   打开那个 `done` 链接，它会返回一个 token。把它粘到终端，npm 就完成发布。

5. 验证：

   ```bash
   npm view dsh-specgate versions
   npx --yes --package=dsh-specgate node -e "console.log('ok')"
   ```

## 或者：跳过 npm，直接用 GitHub 安装（已经可用）

```bash
dsh plugin --profile web add github:aazh2026/dsh-specgate
```

这个路径我**已经实测通过**：bundle 正常挂载，`specgate_cover` 出现在宿主工具
注册表里，schema 对模型可见，在三个真实 example 项目上输出正确。

也可以用 Release 里的预构建 tarball：

```bash
dsh plugin --profile web add \
  https://github.com/aazh2026/dsh-specgate/releases/latest/download/dsh-specgate-0.1.0.tgz
```

## 发布之后我接着做的事

npm 上架后，我会：

1. 配置 npm Trusted Publisher（OIDC 发布链路，和 `specgate-cli` 一样）
2. 把 `dsh-specgate` 的 release workflow 切到 OIDC
3. 在 `awesome-dsh-plugin` 的条目里去掉 `tarball:` 字段、改用 npm 源
4. 更新 README 和 Discussions 帖里的安装命令
