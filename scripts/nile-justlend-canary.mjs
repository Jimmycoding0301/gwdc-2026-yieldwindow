import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TronWeb } from "tronweb";

const RPC = "https://nile.trongrid.io";
const CHAIN_ID = "0xcd8690dc";
const JTRX = "TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq";
const UNIT_SUN = 1_000_000;
const workspace = resolve(import.meta.dirname, "..");
const privateDirectory = resolve(workspace, ".data/justlend-canary");
const publicEvidencePath = resolve(workspace, "docs/evidence/yieldwindow-justlend-canary.json");

const walletPath = process.env.NILE_WALLET_FILE
  ? resolve(process.env.NILE_WALLET_FILE)
  : resolve(workspace, ".data/tron-nile-wallet.json");
const wallet = JSON.parse(await readFile(walletPath, "utf8"));
if (!wallet.privateKey || !wallet.address) throw new Error("Dedicated Nile wallet is missing.");

const tronWeb = new TronWeb({ fullHost: RPC, privateKey: wallet.privateKey });
if (tronWeb.defaultAddress.base58 !== wallet.address) throw new Error("Wallet address does not match its private key.");

const jsonRpc = await fetch(`${RPC}/jsonrpc`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
}).then((response) => response.json());
if (jsonRpc.result !== CHAIN_ID) throw new Error(`Refusing unexpected chain ${jsonRpc.result}.`);

const contract = await tronWeb.contract().at(JTRX);
const symbol = String(await contract.symbol().call());
const name = String(await contract.name().call());
if (symbol !== "jTRX" || name !== "jTOKEN_TRX") throw new Error("Unexpected JustLend market identity.");

const jBalance = async () => BigInt((await contract.balanceOf(wallet.address).call()).toString());
const trxBalance = async () => BigInt(await tronWeb.trx.getBalance(wallet.address));
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function rpc(path, body) {
  const response = await fetch(`${RPC}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Nile RPC ${path} returned ${response.status}.`);
  return response.json();
}

async function waitForSolidity(txID) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [transaction, info] = await Promise.all([
      rpc("/walletsolidity/gettransactionbyid", { value: txID }),
      rpc("/walletsolidity/gettransactioninfobyid", { value: txID }),
    ]);
    if (transaction?.txID && info?.id) {
      const contractRet = transaction.ret?.[0]?.contractRet;
      const receiptResult = info.receipt?.result || "SUCCESS";
      if (contractRet !== "SUCCESS" || receiptResult !== "SUCCESS" || info.result === "FAILED") {
        throw new Error(`Transaction ${txID} failed (${contractRet}/${receiptResult}).`);
      }
      return { transaction, info };
    }
    await sleep(3_000);
  }
  throw new Error(`Transaction ${txID} did not solidify before the timeout.`);
}

async function signPersistBroadcast(transaction, label) {
  const signed = await tronWeb.trx.sign(transaction);
  await mkdir(privateDirectory, { recursive: true });
  const savedPath = resolve(privateDirectory, `${label}-${signed.txID}.json`);
  await writeFile(savedPath, JSON.stringify(signed, null, 2), { mode: 0o600 });
  await chmod(savedPath, 0o600);
  let response;
  try {
    response = await tronWeb.trx.sendRawTransaction(signed);
  } catch {
    // The exact signed bytes are already durable. Never construct a replacement
    // after an ambiguous broadcast; recover by the original txID only.
    response = { result: false, code: "AMBIGUOUS_BROADCAST" };
  }
  if (response?.result === false && response?.code !== "DUP_TRANSACTION_ERROR") {
    const existing = await rpc("/wallet/gettransactionbyid", { value: signed.txID });
    if (!existing?.txID) throw new Error(`Broadcast rejected for ${signed.txID}.`);
  }
  return { txID: signed.txID, settled: await waitForSolidity(signed.txID) };
}

const before = { trxSun: await trxBalance(), jTrxRaw: await jBalance() };
const mintBuild = await tronWeb.transactionBuilder.triggerSmartContract(
  JTRX,
  "mint()",
  { feeLimit: 200_000_000, callValue: UNIT_SUN },
  [],
  wallet.address,
);
if (!mintBuild.result?.result || mintBuild.transaction?.raw_data?.contract?.[0]?.parameter?.value?.call_value !== UNIT_SUN) {
  throw new Error("JustLend mint preflight failed or changed the call value.");
}
const mint = await signPersistBroadcast(mintBuild.transaction, "mint");
const afterMint = { trxSun: await trxBalance(), jTrxRaw: await jBalance() };
if (afterMint.jTrxRaw <= before.jTrxRaw) throw new Error("jTRX balance did not increase after mint.");

const redeemBuild = await tronWeb.transactionBuilder.triggerSmartContract(
  JTRX,
  "redeemUnderlying(uint256)",
  { feeLimit: 200_000_000, callValue: 0 },
  [{ type: "uint256", value: UNIT_SUN }],
  wallet.address,
);
if (!redeemBuild.result?.result) throw new Error("JustLend redeem preflight failed.");
const redeem = await signPersistBroadcast(redeemBuild.transaction, "redeem");
const afterRedeem = { trxSun: await trxBalance(), jTrxRaw: await jBalance() };
if (afterRedeem.jTrxRaw >= afterMint.jTrxRaw) throw new Error("jTRX balance did not decrease after redeem.");

const evidence = {
  schemaVersion: "1.0.0",
  project: "YieldWindow",
  purpose: "A minimal live JustLend V1 write-path canary; it is not the stablecoin treasury plan.",
  network: "TRON Nile",
  chainId: CHAIN_ID,
  rpc: RPC,
  ownerAddress: wallet.address,
  market: { name, symbol, address: JTRX, underlying: "TRX", amountSun: UNIT_SUN },
  balances: {
    before: { trxSun: before.trxSun.toString(), jTrxRaw: before.jTrxRaw.toString() },
    afterMint: { trxSun: afterMint.trxSun.toString(), jTrxRaw: afterMint.jTrxRaw.toString() },
    afterRedeem: { trxSun: afterRedeem.trxSun.toString(), jTrxRaw: afterRedeem.jTrxRaw.toString() },
  },
  mint: {
    txID: mint.txID,
    explorerUrl: `https://nile.tronscan.org/#/transaction/${mint.txID}`,
    blockNumber: mint.settled.info.blockNumber,
    blockTimeStamp: mint.settled.info.blockTimeStamp,
    feeSun: mint.settled.info.fee ?? 0,
    energyUsageTotal: mint.settled.info.receipt?.energy_usage_total ?? 0,
    result: mint.settled.transaction.ret?.[0]?.contractRet,
  },
  redeem: {
    txID: redeem.txID,
    explorerUrl: `https://nile.tronscan.org/#/transaction/${redeem.txID}`,
    blockNumber: redeem.settled.info.blockNumber,
    blockTimeStamp: redeem.settled.info.blockTimeStamp,
    feeSun: redeem.settled.info.fee ?? 0,
    energyUsageTotal: redeem.settled.info.receipt?.energy_usage_total ?? 0,
    result: redeem.settled.transaction.ret?.[0]?.contractRet,
  },
  generatedAt: new Date().toISOString(),
  integrity: "",
  boundary: [
    "This canary proves a real JustLend deposit and redemption on Nile using 1 test TRX.",
    "It does not claim that the USDT/USDD treasury allocation was executed.",
    "Signed transactions and the test private key are stored only in ignored local .data files.",
  ],
};
evidence.integrity = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
await mkdir(dirname(publicEvidencePath), { recursive: true });
await writeFile(publicEvidencePath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o644 });
console.log(JSON.stringify({ evidence: publicEvidencePath, mint: evidence.mint, redeem: evidence.redeem, balances: evidence.balances }, null, 2));
