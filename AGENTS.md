修改代码后，部署到腾讯云服务器 124.223.100.121，这个服务器的域名是https://hzai.work
访问密钥 202609yangli-tencent腾讯云.pem
登录用户名 root（实测确认，不是 ubuntu）；代码目录 /srv/myorgniz，Docker Compose，详情见 docs/DEPLOYMENT.md
在首页或项目页面，从聊天群里提取的进展，用绿色字体显示的，我们称为“进展”。
需求与架构总纲见 docs/PRD.md，docs/ 下有索引。

## 发布规范（必须遵守）

1. **每次发布，代码必须推送到 GitHub**：部署完成后 `git push origin main`，生产代码 = GitHub main 最新提交，不允许本地有未推送的发布代码。远程仓库：git@github.com:HZORGNIZ/org.git
2. **每天开始开发前，先检查版本是否最新**：`git pull origin main`（或先 `git fetch` + `git status` 对比），确认本地与远程一致后再动代码，避免在旧版本上开发产生冲突。
3. 完整发布流程（打包 → 上传 → 备份 → 构建 → 切换 → db push → 探活 → 推 GitHub）见 docs/DEPLOYMENT.md §5。
