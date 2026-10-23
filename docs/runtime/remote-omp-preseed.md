# 无缓存桌面的远程 OMP 安装前置

适用范围：内部验收使用的 Linux x64 SSH 主机和 OMP 18.10.3。Phi 桌面端从本机缓存向服务器上传二进制；服务器不需要直连 GitHub。此方案不改变远程 RPC 的默认开关。

若新桌面无法从官方发布页下载资产，先从[官方 18.10.3 发布资产](https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/omp-linux-x64)取得 `omp-linux-x64`，或从另一台**已经按下列 SHA-256 验证**的 Phi 桌面安全复制该文件。不要直接信任文件名或来源机器。

在新 Mac 上将文件放入 Phi 的正式缓存：

```bash
cache_dir="$HOME/.phi/cache/omp/omp/18.10.3/linux-x64"
mkdir -p "$cache_dir"
chmod 700 "$HOME/.phi/cache/omp" "$HOME/.phi/cache/omp/omp" "$HOME/.phi/cache/omp/omp/18.10.3" "$cache_dir"
install -m 600 /绝对路径/omp-linux-x64 "$cache_dir/omp"
shasum -a 256 "$cache_dir/omp"
```

输出必须**严格等于** `366ffcda80db57b825921b6ff4b0e5e623bc62cf18478f2828cd8a322fc72ff9`。随后使用 `PHI_REMOTE_OMP_RPC=1` 启动当前候选，在远程项目中新建一次会话；Phi 会再次校验缓存哈希，并按生产启动事务安装到服务器。缓存损坏、符号链接、非本人所有或多硬链接文件会被拒绝，不能跳过校验。

2026-10-23 用 276170720 字节的官方 x64 资产在全新临时缓存目录实测生产 `ensureCachedRemoteOmp`：`cacheHit=true`、`networkRequests=0`。node3 与 GPU 的候选 `98a8508d` R8 均使用经校验的缓存通过。此证据证明**预置后**能离线命中，不证明全新桌面从官方源完整下载的耗时或可用性；部署前仍须在目标桌面完成上述复制与 SHA-256 核验。
