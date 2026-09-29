# Nile 计划收据

YieldWindow 的资金动作仍是模拟。链上部分记录提交地址对这份分配计划摘要的承诺及其区块时间，不代表 JustLend 存入或收益到账。

本次提交已核验的 Nile Registry 为 [`TSqoRAmu4qviTuscsakTWdYRZQjpiTjP2u`](https://nile.tronscan.org/#/contract/TSqoRAmu4qviTuscsakTWdYRZQjpiTjP2u)，计划收据交易为 [`4adaf2cf…a51`](https://nile.tronscan.org/#/transaction/4adaf2cfc03e80c36533cad6024e17de463eedc2efef66da3c1873602c1fca51)。以下步骤用于复核或部署新的测试网实例。

## 部署共享 ReceiptRegistry

1. 在 TronIDE 打开 [`contracts/ReceiptRegistry.sol`](../contracts/ReceiptRegistry.sol)。
2. 选择 Solidity `0.8.20`。
3. 开启 optimizer，`runs = 200`，EVM target 选择 `paris`。完整参数记录在 [`contracts/compiler-settings.json`](../contracts/compiler-settings.json)。
4. TronLink 切换到 **Nile** 后部署，constructor 无参数，call value 为 `0`。
5. 在 TRONSCAN 中保存部署交易与合约地址，并尽量上传同一份源码和编译参数完成验证。
6. 复制 `.env.example` 为 `.env`，填入公开合约地址。`NILE_RPC_URL` 可保留默认值：

```dotenv
NILE_RECEIPT_REGISTRY_ADDRESS=T...
NILE_RPC_URL=https://nile.trongrid.io
```

这个合约只提供通用接口，可与其他项目共用：

```solidity
function commit(bytes32 kind, bytes32 digest) external;

event ReceiptCommitted(
    address indexed submitter,
    bytes32 indexed kind,
    bytes32 digest,
    uint256 timestamp
);
```

YieldWindow 的 `kind` 是 UTF-8 `yieldwindow.plan.v1` 补零到 `bytes32`：

```text
0x7969656c6477696e646f772e706c616e2e763100000000000000000000000000
```

## 收据内容

规范化 JSON 绑定：

- 市场快照 ID、模式、数据源、采集时间与利率；
- 卖家款、退款 / 物流缓冲、总准备金、用款日和规划期；
- 每个币种留在钱包或计划配置到 JustLend 的整数微单位；
- 保守净值、激励持续情景、全周期成本与“非保证”标记；
- 假设、风险、退出条件和用户确认时间。

对规范化 JSON 计算 SHA-256。浏览器在签名前同时核对规范 JSON 和 SHA-256；服务端在预存签名交易、广播与链上核验时都从当前冻结计划重建收据。

## 签名前限制

- 优先使用现代 `window.tron` + `eth_requestAccounts`，旧版 TronLink 才回退到 `window.tronLink`。
- 优先要求 chain ID `0xcd8690dc` 并尝试切换；旧版 TronLink 无法返回 chain ID 时，要求 TronWeb FullNode host 明确指向 Nile。非 Nile 直接拦截。
- 交易必须只包含一个 `TriggerSmartContract`。
- 目标必须是配置的 ReceiptRegistry，call value 和 token value 都是 `0`。
- calldata 必须精确等于 `commit(kind,digest)`，fee limit 不超过 30 Nile TRX。
- 签名后再核对 txID 没有变化、签名存在，且全部待签字段仍与当前收据一致。
- 服务端要求 txID 等于 `SHA-256(raw_data_hex)`，检查签名格式和完整交易字段，然后在广播前持久化 txID、完整签名交易及其指纹。

TRON 的 `TransferContract` 会拒绝 `amount <= 0`，同时拒绝向自己转账。因此这里没有伪造“0 TRX 自转账”，而是使用协议允许的零 call-value 合约调用。交易仍会消耗 Nile 带宽 / 能量，fee limit 是上限，不是实际扣费。

## 广播与恢复

本机服务只广播预存的原始签名交易。每次广播前都先从 Nile FullNode 查询原 txID：已存在就不重复广播；查询不可用就保留 `广播待确认`，不冒险重播。若广播请求超时或返回不确定，服务端再查询同一 txID；后续重试也只能查询或重播同一份已保存签名字节，不会重建交易。

## 独立核验

服务端只从 Nile 的 `walletsolidity` 固化视图把收据标记为“已固化”：

1. txID 存在且交易已固化；
2. owner、registry、零价值与 calldata 全部匹配；
3. 交易 `contractRet`、固化回执 `receipt.result` 均为 `SUCCESS`，且回执未标记 `FAILED`；
4. block number 与 block timestamp 是安全正整数；
5. 同一 registry 发出的 `ReceiptCommitted` 事件中，submitter、kind、digest 全部匹配，事件 timestamp 与固化区块时间一致。

界面分开显示 `签名已保存`、`广播待确认`、`已广播`、`已固化`、`执行失败` 和 `校验不一致`。
