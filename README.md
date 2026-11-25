# dsh-approval-reason-relay

你拒绝一次审批时，把审批方给出的理由带回工具结果——智能体因此知道**为什么**被拒，
而不是只看到「用户拒绝了」。自动审查（Auto review）交给你裁决的调用是主要场景：
拒绝之后，智能体能读到审查模型给出的拒绝理由。

- 只加模型可见文本，不改决策。
- 不 fork 自动审查，不动 DSH 核心。
- 理由原样保留，不翻译。

原理、边界与兼容性见 [docs/DETAIL.md](docs/DETAIL.md)。

## 安装（本地目录）

```
plugin_manager { action: "install_bundle", target: "<此目录的绝对路径>" }
```
