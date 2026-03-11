# Emby 302 Proxy

🥳 Docker 一键部署 | 支持 115 网盘直链 | Emby 播放地址 302 转发

一个面向 Emby/Jellyfin 的 302 转发服务：拦截播放请求后读取 `strm` 内容，调用 p115client 获取直链，按策略返回 302 或强制代理。

## ⚡ 快速开始

```bash
# Docker 一键部署
mkdir emby302 && cd emby302
curl -sL https://raw.githubusercontent.com/01dmt/emby417/main/docker-compose.yml > docker-compose.yml
docker compose up -d
```

访问管理台配置 Cookie：`http://你的NAS或服务器IP:8417/admin/`

## 🐳 Docker 部署

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEB_UI_PORT` | 8417 | 管理台端口 |
| `CANONICAL_HOST` | 空 | 规范访问域名；设置后会把其他 Host 308 跳转到该域名 |
| `TZ` | Asia/Shanghai | 时区 |

### 启动

```bash
docker run -d \
  --name emby-302-proxy \
  -p 8417:8417 -p 5088:5088 -p 5089:5089 \
  -v ./data:/data \
  --restart unless-stopped \
  01dmt/emby417
```

或使用 docker-compose：

```yaml
services:
  emby-302-proxy:
    image: 01dmt/emby417
    container_name: emby-302-proxy
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
    ports:
      - "8417:8417"  # 管理台，可改成 "9000:8417"
      # Emby 反代端口按你自己的入口配置自行放行，例如：
      # - "5088:5088"
      # - "5089:5089"
    volumes:
      - ./data:/data
```

`CANONICAL_HOST` 的作用：
- 留空时不做域名跳转，适合大多数部署场景。
- 设置后会把 `localhost`、`127.0.0.1` 或其他 Host 统一 308 跳转到你指定的域名/IP。

## ⚙️ 首次配置

1. 启动容器后访问 `http://你的NAS或服务器IP:8417/admin/`
2. 在管理后台配置 115 Cookie（获取方法：登录 115 网页版 → F12 → Application → Cookies）
3. 保存后即可使用

## 🔧 Caddy 入口配置

```caddy
emby.example.com {
  # 播放地址拦截转发
  handle_path /emby/videos/* {
    reverse_proxy http://127.0.0.1:8417
  }

  # 其他请求转发到 Emby
  handle {
    reverse_proxy http://127.0.0.1:8096
  }
}
```

## 📁 数据持久化

容器内 `/data` 目录：
- `config.json` - 配置文件（Cookie、缓存配置等）
- `logs/app.log` - 统一运行日志（Node / bridge / Caddy）
- `logs/requests.jsonl` - 请求过程日志

清理仓库根目录历史临时日志：

```bash
npm run clean:logs
```

## 🔌 API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/admin/` | GET | 管理后台 |
| `/api/config` | GET/PUT | 配置读取/修改 |
| `/api/status` | GET | 服务状态 |
| `/api/logs` | GET | 请求日志 |
| `/api/cache/clear` | POST | 清除缓存 |
| `/emby/videos/*` | GET | Emby 播放拦截入口 |
| `/play?strmPath=...` | GET | 直接指定 STRM 路径 |
| `/play?pickcode=...` | GET | 直接指定 PickCode |

## 📁 目录结构

```
src/modules   # 核心逻辑
src/routes    # HTTP 路由
public        # 管理台静态资源
bridge/       # 115 API Bridge
```
