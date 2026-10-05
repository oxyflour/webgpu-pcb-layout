# 镜像、启动与构建

以下 PowerShell 命令从项目根目录执行。先检查当前资源，再选择启动或新建容器，不要盲目重建。

Node 依赖缺失时，按项目 README 执行 `npm install --no-package-lock`；CUDA 镜像中的 Python 依赖与主机 Node/WebGPU 依赖分别检查。

```powershell
docker image inspect cypress:20261004 --format '{{.Id}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}'
docker ps -a --filter 'name=codex-cypress' --format '{{.Names}} {{.Status}} {{.Image}}'
$container = 'codex-cypress-official-20261004'
docker start $container
docker exec $container nvidia-smi
docker exec $container python3 -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

容器不存在且镜像存在时，用以下命令替代 `docker start`，然后做 CUDA 检查：

```powershell
docker run -d --name $container --gpus all --ipc=host -w /Cypress/install cypress:20261004 sleep infinity
```

实测镜像 ID 为 `sha256:a532b60e07ccd96d051f2c27e02a920c7254267b0a9ed54b9fb31f4ee452ef93`。Docker 标签可变，以实际 inspect 为准。其 ENTRYPOINT 是 `/opt/nvidia/nvidia_entrypoint.sh`，CMD 是 `sleep infinity`；启动只保持容器存活，求解要通过 `docker exec` 单独调用。

镜像已有 `/Cypress/install`、源码和依赖。当前 checkout 的 wrapper 比镜像内部副本更新时，复制当前文件；benchmark 的 cypress 阶段会自动这样做：

```powershell
docker cp bench/cypress/run.py "${container}:/work/run.py"
```

已验证环境：RTX 3090 Ti、Ubuntu 22.04、CUDA toolkit 11.8、Python 3.10、PyTorch 1.13.1+cu117、NumPy 1.23.5。其他 GPU 需检查驱动、CUDA 和编译架构兼容性。本机结果中的硬件描述不能直接套用到另一台机器。

## 仅在镜像缺失或要求重编译时

`setup.sh` 会修改 apt 源和安装软件，`build.sh` 会修补上游源码；只在专用 Linux CUDA 容器内运行。复用已编译镜像通常不需要这些步骤。

新建专用容器（选择可访问的同版本镜像源）：

```powershell
$container = 'codex-cypress-build'
docker run -d --name $container --gpus all --ipc=host nvidia/cuda:11.8.0-cudnn8-devel-ubuntu22.04 sleep infinity
docker exec $container mkdir -p /work
docker cp bench/cypress/. "${container}:/work/"
docker exec $container bash -lc 'sed -i "s/\r$//" /work/*.sh'
docker exec $container bash /work/setup.sh
docker exec $container git -c core.autocrlf=false clone https://github.com/NVlabs/Cypress.git /Cypress
docker exec $container git -C /Cypress checkout 743b07c4e33dc52a00584d55d2e67f38f70957f5
docker exec $container git -C /Cypress submodule update --init --recursive
docker exec $container bash /work/build.sh
docker exec -w /Cypress/install $container python3 /work/verify_ops.py
```

逐条检查退出码再继续。`build.sh` 的 `CUDA_ARCH_LIST=8.6` 对应已验证 GPU；不同 GPU 先修改容器内脚本的架构值。构建日志是 `/work/configure.log`、`/work/build.log`、`/work/install.log`。修补脚本按 fresh checkout 编写，失败后先检查源码状态，避免反复对已修改源码打补丁。

修补层包括 `patch_cypress.py`、`compat.py`、`runtime_fixes.py`。这是 adapted/corrected Cypress，报告应披露。`verify_ops.py` 检查 CUDA crossing 得分/梯度与独立 CPU 参考；更换源码或二进制后重跑并保存输出。

从 Windows 移植源码时保持 FLUTE `.dat` 文件的原始 Git 字节，避免 CRLF 改写造成 RSMT 崩溃。优先在容器里 Git clone；不要把 `.dat` 当文本统一换行。

`run.py` 已处理 cuRAND 的显式加载及 CPU 线程数。不要用系统最新 Torch/NumPy 覆盖已验证依赖来“修复”导入问题。先保存具体异常、版本和日志，再修复对应兼容性。

完成并验证新构建后，只有请求保存镜像时才用新标签 `docker commit`；不要覆盖现有实验标签。容器用于后续调用可保留，不删除历史结果。
