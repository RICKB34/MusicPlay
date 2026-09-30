# 部署到公网

当前项目推荐采用**单体部署**：

- Node 服务同时提供 `dist/` 静态网页与 WebSocket 对战服务
- 网页和 WebSocket 同源，不需要配置跨域
- 平台提供 HTTPS 后，浏览器会自动使用 WSS

## 一、推送到 GitHub

在项目根目录执行：

```bash
git init
git add .
git commit -m "deploy rhythm forge"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

如果项目已经在 Git 仓库中，只需要提交并推送最新代码。

## 二、使用 Render 部署

1. 打开 <https://render.com> 并登录。
2. 选择 **New → Web Service**。
3. 连接 GitHub 仓库。
4. 填写：
   - Runtime：`Node`
   - Build Command：`npm ci && npm run build`
   - Start Command：`npm start`
   - Health Check Path：`/`
5. 添加环境变量：
   - `NODE_VERSION=22.12.0`
6. 点击 **Create Web Service**。

仓库里的 `render.yaml` 也可以直接作为 Blueprint 使用。

部署完成后，Render 会提供一个类似下面的地址：

```text
https://rhythm-forge.onrender.com
```

打开该地址即可访问。对战服务会自动使用同源的 WSS 地址。

## 三、前端与对战服务分开部署

如果网页部署到 Vercel、Cloudflare Pages、Netlify，而 WebSocket 服务单独部署在 Render：

1. 先部署 Node 服务，拿到类似 `https://rhythm-server.onrender.com` 的地址。
2. 在前端部署平台中添加环境变量：

```text
VITE_WS_URL=wss://rhythm-server.onrender.com
```

3. 重新执行前端构建并部署。

本地可参考 `.env.example`。

## 四、部署后的限制

- 房间数据保存在进程内存中，服务重启后房间会清空。
- 当前设计适合单实例。不要直接把 Render 实例扩到多个副本，否则不同玩家可能连到不同内存中的房间。
- 免费实例在一段时间无访问后可能休眠，首次打开会慢一些，WebSocket 连接也可能需要等待服务启动。
- 音频始终在玩家浏览器本地分析，不会上传到服务器。
