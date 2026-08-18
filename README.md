# Git Publish Studio

仅在本机运行的 Git 提交、同步和克隆工作台。

安装依赖后执行 `npm start`，再打开终端中显示的本机地址。

```bash
npm install
npm start
```

工具支持 Windows、macOS 和 Linux，可通过网页内置目录浏览器选择磁盘和文件夹，不限制盘符或固定工作目录，也不依赖额外的系统选择器组件。

服务仅监听 `127.0.0.1`，不会向局域网开放；文件操作接口同时校验当前页面会话令牌。
