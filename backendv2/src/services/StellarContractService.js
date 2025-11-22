const { Buffer } = require('buffer');

class StellarContractService {
  static extractCpuInstructions(tx) {
    const sim = tx?.simulation;
    const resources = sim?.transactionData?._data?._attributes?.resources?._attributes;
    if (resources && resources.instructions) {
      return parseInt(resources.instructions.toString());
    }
    return undefined;
  }

  static extractTransactionData(result) {
    const txHash = result?.hash || result?.transactionHash || (typeof result === 'string' ? result : '');
    let fee;
    let txResponse = null;
    if (typeof result?.getTransactionResponse === 'function') {
      try { txResponse = result.getTransactionResponse(); } catch (_) {}
    } else if (result?.response) {
      txResponse = result.response;
    } else if (result?.transactionResponse) {
      txResponse = result.transactionResponse;
    } else if (result && typeof result === 'object' && 'status' in result) {
      txResponse = result;
    }
    if (txResponse) {
      if (txResponse.resultXdr && typeof txResponse.resultXdr.feeCharged === 'function') {
        fee = txResponse.resultXdr.feeCharged().toString();
      } else if (txResponse.feeCharged) {
        fee = txResponse.feeCharged.toString();
      } else if (txResponse.fee) {
        fee = txResponse.fee.toString();
      }
    }
    return { txHash, fee, success: true };
  }

  static formatStroopsToXlm(stroops) {
    const n = typeof stroops === 'string' ? parseInt(stroops) : stroops;
    return (n / 10_000_000).toFixed(7);
  }

  static toBuffer(data) { return Buffer.from(data); }
}

module.exports = { StellarContractService };