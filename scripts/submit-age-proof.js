#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import StellarSdk from '@stellar/stellar-sdk';
import child_process from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function toYyyymmdd(date) {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return Number(`${y}${m}${d}`);
}

function parseDob(input) {
  const parts = input.split('-');
  if (parts.length !== 3) throw new Error('Formato esperado: YYYY-MM-DD');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) throw new Error('Data inválida');
  return Number(`${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`);
}

function run(cmd, cwd) {
  const res = child_process.spawnSync(cmd, { shell: true, cwd, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`Falha ao executar: ${cmd}`);
}

function execCapture(cmd, cwd) {
  const res = child_process.spawnSync(cmd, { shell: true, cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (res.status !== 0) throw new Error(`Falha ao executar: ${cmd}`);
  return res.stdout.toString();
}

async function main() {
  const dobArg = process.argv[2];
  if (!dobArg) {
    console.error('Uso: submit-age-proof.js YYYY-MM-DD <CONTRACT_ID>');
    process.exit(1);
  }
  const contractId = process.argv[3] || '';

  const birth = parseDob(dobArg);
  const today = toYyyymmdd(new Date());

  const noirDir = path.join(__dirname, '..', 'circuit');
  const programPath = path.join(noirDir, 'target', 'age_check.json');
  if (!fs.existsSync(programPath)) {
    console.error('Programa Noir compilado não encontrado em', programPath);
    console.error('Compile uma vez com: nargo check (ou nargo compile) dentro de circuit');
    process.exit(1);
  }
  const program = JSON.parse(fs.readFileSync(programPath, 'utf-8'));

  const noir = new Noir(program);
  const inputs = { birth, today };
  const { witness, returnValue } = await noir.execute(inputs);
  let proof, publicInputs;
  try {
    const backend = new UltraHonkBackend(program.bytecode);
    ({ proof, publicInputs } = await backend.generateProof(witness));
  } catch (e) {
    console.error('Falha ao gerar prova com Barretenberg:', e.message || e);
    console.error('Dica: recompile o circuito com a mesma versão do Noir/Nargo que corresponde ao runtime (@noir-lang/noir_js) e backend_barretenberg.');
    console.error('Ex.: reinstale Noir via noirup na mesma versão que gerou age_check.json e rode nargo check novamente.');
    process.exit(1);
  }
  const publicFlattened = Buffer.concat(publicInputs.map(hexToBytes));

  const publicBuf = Buffer.allocUnsafe(4);
  publicBuf.writeUInt32BE(today);

  if (!contractId) {
    console.log('Prova (barretenberg) gerada em runtime (hex):', Buffer.from(proof).toString('hex'));
    console.log('Public inputs (bytes32[]) como hex concatenado):', Buffer.from(publicFlattened).toString('hex'));
    console.log('Resultado do circuito (maior de 18?):', returnValue);
    console.log('Para invocar via CLI:');
    console.log('soroban contract invoke --id <CONTRACT_ID> --fn verify -- --proof ' + Buffer.from(proof).toString('hex') + ' --public ' + Buffer.from(publicFlattened).toString('hex'));
    process.exit(0);
  }

  const npmBin = execCapture('npm bin', __dirname).trim();
  const bb = path.join(npmBin, 'bb.js');
  const vkJson = execCapture(`${bb} vk_as_fields -b ${programPath} -o -`, path.join(__dirname, '..'));

  const countBuf = Buffer.allocUnsafe(4);
  countBuf.writeUInt32BE(publicInputs.length);
  const proofBlob = Buffer.concat([countBuf, publicFlattened, Buffer.from(proof)]);

  const { Keypair, SorobanRpc, Contract, TransactionBuilder, BASE_FEE, Networks, nativeToScVal } = StellarSdk;
  const server = new SorobanRpc.Server('http://localhost:8000/rpc');
  const networkPassphrase = Networks.STANDALONE;
  const secret = process.env.SOROBAN_SECRET || '';
  let kp;
  if (secret) {
    kp = Keypair.fromSecret(secret);
  } else {
    kp = Keypair.random();
    await fetch(`http://localhost:8000/friendbot?addr=${kp.publicKey()}`);
  }

  const contract = new Contract(contractId);
  const account = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call('verify_proof', nativeToScVal(Buffer.from(vkJson, 'utf8')), nativeToScVal(proofBlob)))
    .setTimeout(60)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(kp);
  const send = await server.sendTransaction(tx);
  if (send.errorResultXdr) {
    console.error('Falha ao enviar transação:', send.errorResultXdr);
    process.exit(1);
  }
  let status = await server.getTransaction(send.hash);
  while (status.status === SorobanRpc.GetTransactionStatus.NOT_FOUND) {
    await new Promise(r => setTimeout(r, 1000));
    status = await server.getTransaction(send.hash);
  }
  if (status.status !== SorobanRpc.GetTransactionStatus.SUCCESS) {
    console.error('Transação não confirmada:', status);
    process.exit(1);
  }
  console.log('Transação confirmada:', send.hash);
  if (status.resultXdr) {
    console.log('Resultado (XDR base64):', status.resultXdr);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(clean, 'hex');
}