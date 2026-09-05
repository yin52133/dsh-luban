# **PACKAGE_NAME**

**DESCRIPTION**.

## 功能亮点

- Host 生命周期遵循 Cordis effect/dispose 契约。
- Manifest 与 DSH `0.1.2-rc.1` 的 bundle/client 发现机制兼容。
- 发布内容由 npm `files` 白名单约束。

## 安装

```sh
dsh plugin --profile <profile> add __PACKAGE_NAME__
```

## 配置

默认 patch 可直接复制；此中性模板没有额外配置项：

```yaml
- insert:
    - id: __PLUGIN_ID__
      name: '__PACKAGE_NAME__'
```

## 截图 / 演示

此脚手架不声明通用 Web slot。实现 UI 后，请补充实际截图或演示。

## 兼容性

| DSH          | 状态        |
| ------------ | ----------- |
| `0.1.2-rc.1` | CI 目标版本 |

Manifest 下限：`engines.dsh` = `__DSH_ENGINE__`。

## 平台支持

Host 模板支持 Windows 与 Ubuntu；平台专属能力必须收口到 HAL。

## License 与致谢

MIT。第三方声明见 `THIRD-PARTY-NOTICES.md`。
