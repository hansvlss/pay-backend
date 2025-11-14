# 使用轻量且稳定的 Node 运行环境
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 拷贝 package.json（和 package-lock.json，如果有）
COPY package.json ./

# 安装依赖
RUN npm install --production

# 拷贝所有应用文件
COPY . .

# 暴露端口（和 app.js 中保持一致）
EXPOSE 3000

# 启动命令
CMD ["node", "app.js"]
