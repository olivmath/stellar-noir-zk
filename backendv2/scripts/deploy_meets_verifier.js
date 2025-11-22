const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  Keypair,
  TransactionBuilder,
  Operation,
  Address,
} = require("@stellar/stellar-sdk");
const { Server: RpcServer } = require("@stellar/stellar-sdk/rpc");

async function main() {
  const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
  const RPC_URL = process.env.STELLAR_RPC_URL || "http://localhost:8000/rpc";
  const HORIZON = process.env.STELLAR_HORIZON || "http://localhost:8000";
  const SECRET = process.env.SECRET || undefined;

  const keypair = SECRET ? Keypair.fromSecret(SECRET) : Keypair.random();
  const server = new RpcServer(RPC_URL, { allowHttp: true });

  let account = await server.requestAirdrop(keypair.publicKey(), `${HORIZON.replace(/\/$/, "")}/friendbot`);

  const wasmCandidates = [
    path.join(process.cwd(), "smartcontracts/target/wasm32v1-none/release/meets_verifier.wasm"),
    path.join(process.cwd(), "smartcontracts/target/wasm32-unknown-unknown/release/meets_verifier.wasm"),
  ];
  let wasmPath = undefined;
  for (const p of wasmCandidates) {
    if (fs.existsSync(p)) { wasmPath = p; break; }
  }
  if (!wasmPath) throw new Error("WASM do contrato não encontrado. Compile antes de fazer deploy.");
  const wasm = fs.readFileSync(wasmPath);
  const wasmHash = crypto.createHash("sha256").update(wasm).digest();

  const feeStats = await server.getFeeStats().catch(() => ({ fee_charged: { mode: "10000" } }));
  const fee = String(feeStats.fee_charged?.mode || "10000");

  const uploadTx = new TransactionBuilder(account, { fee, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(30)
    .build();
  const preparedUpload = await server.prepareTransaction(uploadTx);
  preparedUpload.sign(keypair);
  const sentUpload = await server.sendTransaction(preparedUpload);
  if (sentUpload.status === "PENDING") {
    await server.pollTransaction(sentUpload.hash, { attempts: 10 });
  }

  const mod = await import("@stellar/stellar-sdk/contract");
  const ContractClient = mod.ContractClient || mod.Client;
  const txDeploy = await ContractClient.deploy(undefined, {
    publicKey: keypair.publicKey(),
    wasmHash,
    salt: crypto.randomBytes(32),
    rpcUrl: RPC_URL,
    allowHttp: true,
    networkPassphrase: NETWORK_PASSPHRASE,
    fee,
    timeoutInSeconds: 30,
    publicKey: keypair.publicKey(),
  });
  const resultDeploy = await txDeploy.signAndSend({
    signTransaction: async (xdr) => {
      const txObj = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      txObj.sign(keypair);
      return { signedTxXdr: txObj.toXDR(), signerAddress: keypair.publicKey() };
    },
  });
  const client = resultDeploy.result;
  const contractId = client?.options?.contractId;
  if (!contractId) throw new Error("Falha ao obter o ID do contrato após deploy");

  console.log(JSON.stringify({
    success: true,
    contractId,
    wasmHashHex: wasmHash.toString("hex"),
    account: keypair.publicKey(),
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ success: false, error: String(e?.message || e) }));
  process.exit(1);
});