import { RippleAPI } from 'ripple-lib';
import rippleBinaryCodec from 'ripple-binary-codec';
import { Key } from '../../derivation';
import { Payment } from 'ripple-lib/dist/npm/transaction/payment';
import { Instructions, Prepare, TransactionJSON } from 'ripple-lib/dist/npm/transaction/types';
import { toRippledAmount, txFlags, validate, xrpToDrops } from 'ripple-lib/dist/npm/common';
import { ValidationError } from 'ripple-lib/dist/npm/common/errors';
import * as _ from 'lodash'
import { Adjustment, Amount, MaxAdjustment, Memo, MinAdjustment } from 'ripple-lib/dist/npm/common/types/objects';
import { ApiMemo, common } from 'ripple-lib/dist/npm/transaction/utils';
import BigNumber from 'bignumber.js';

class Utils {
  _removeUndefined<T extends object>(obj: T): T {
    return _.omitBy(obj, _.isUndefined) as T
  }

  _convertStringToHex(string: string): string {
    return Buffer.from(string, 'utf8').toString('hex').toUpperCase()
  }

  _convertMemo(memo: Memo): {Memo: ApiMemo} {
    return {
      Memo: this._removeUndefined({
        MemoData: memo.data ? this._convertStringToHex(memo.data) : undefined,
        MemoType: memo.type ? this._convertStringToHex(memo.type) : undefined,
        MemoFormat: memo.format ? this._convertStringToHex(memo.format) : undefined
      })
    }
  }


  _setCanonicalFlag(txJSON: TransactionJSON): void {
    txJSON.Flags |= txFlags.Universal.FullyCanonicalSig

    // JavaScript converts operands to 32-bit signed ints before doing bitwise
    // operations. We need to convert it back to an unsigned int.
    txJSON.Flags = txJSON.Flags >>> 0
  }

  static _scaleValue(value, multiplier, extra = 0) {
    return (new BigNumber(value)).times(multiplier).plus(extra).toString()
  }
  static _dropsToXrp(drops: string | BigNumber): string {
    if (typeof drops === 'string') {
      if (!drops.match(/^-?[0-9]*\.?[0-9]*$/)) {
        throw new ValidationError(`dropsToXrp: invalid value '${drops}',` +
          ` should be a number matching (^-?[0-9]*\.?[0-9]*$).`)
      } else if (drops === '.') {
        throw new ValidationError(`dropsToXrp: invalid value '${drops}',` +
          ` should be a BigNumber or string-encoded number.`)
      }
    }

    // Converting to BigNumber and then back to string should remove any
    // decimal point followed by zeros, e.g. '1.00'.
    // Important: specify base 10 to avoid exponential notation, e.g. '1e-7'.
    drops = (new BigNumber(drops)).toString(10)

    // drops are only whole units
    if (drops.includes('.')) {
      throw new ValidationError(`dropsToXrp: value '${drops}' has` +
        ` too many decimal places.`)
    }

    // This should never happen; the value has already been
    // validated above. This just ensures BigNumber did not do
    // something unexpected.
    if (!drops.match(/^-?[0-9]+$/)) {
      throw new ValidationError(`dropsToXrp: failed sanity check -` +
        ` value '${drops}',` +
        ` does not match (^-?[0-9]+$).`)
    }

    return (new BigNumber(drops)).dividedBy(1000000.0).toString(10)
  }

  _formatPrepareResponse(txJSON: any): Prepare {
    const instructions = {
      fee: Utils._dropsToXrp(txJSON.Fee),
      sequence: txJSON.Sequence,
      maxLedgerVersion: txJSON.LastLedgerSequence === undefined ?
        null : txJSON.LastLedgerSequence
    }
    return {
      txJSON: JSON.stringify(txJSON),
      instructions
    }
  }

  _prepareTransaction(txJSON: TransactionJSON, api: RippleAPI,
                      instructions: Instructions
  ): Prepare {
    common.validate.instructions(instructions)
    common.validate.tx_json(txJSON)
    const disallowedFieldsInTxJSON = ['maxLedgerVersion', 'maxLedgerVersionOffset', 'fee', 'sequence']
    const badFields = disallowedFieldsInTxJSON.filter(field => txJSON[field])
    if (badFields.length) {
      throw new ValidationError('txJSON additionalProperty "' + badFields[0] +
        '" exists in instance when not allowed')
    }

    // To remove the signer list, SignerEntries field should be omitted.
    if (txJSON['SignerQuorum'] === 0) {
      delete txJSON.SignerEntries
    }

    const account = txJSON.Account
    this._setCanonicalFlag(txJSON)

    function prepareMaxLedgerVersion(): TransactionJSON {
      // Up to one of the following is allowed:
      //   txJSON.LastLedgerSequence
      //   instructions.maxLedgerVersion
      //   instructions.maxLedgerVersionOffset
      if (txJSON.LastLedgerSequence && instructions.maxLedgerVersion) {
        throw new ValidationError('`LastLedgerSequence` in txJSON and `maxLedgerVersion`' +
          ' in `instructions` cannot both be set')
      }
      if (txJSON.LastLedgerSequence && instructions.maxLedgerVersionOffset) {
        throw new ValidationError('`LastLedgerSequence` in txJSON and `maxLedgerVersionOffset`' +
          ' in `instructions` cannot both be set')
      }
      if (txJSON.LastLedgerSequence) {
        return txJSON
      }
      if (instructions.maxLedgerVersion !== undefined) {
        if (instructions.maxLedgerVersion !== null) {
          txJSON.LastLedgerSequence = instructions.maxLedgerVersion
        }
        return txJSON
      }
      throw new Error('Could not prepare Max Ledger Version')
    }

    function prepareFee(): TransactionJSON {
      // instructions.fee is scaled (for multi-signed transactions) while txJSON.Fee is not.
      // Due to this difference, we do NOT allow both to be set, as the behavior would be complex and
      // potentially ambiguous.
      // Furthermore, txJSON.Fee is in drops while instructions.fee is in XRP, which would just add to
      // the confusion. It is simpler to require that only one is used.
      if (txJSON.Fee && instructions.fee) {
        throw new ValidationError('`Fee` in txJSON and `fee` in `instructions` cannot both be set')
      }
      if (txJSON.Fee) {
        // txJSON.Fee is set. Use this value and do not scale it.
        return txJSON
      }
      const multiplier = instructions.signersCount === undefined ? 1 :
        instructions.signersCount + 1
      if (instructions.fee !== undefined) {
        const fee = new BigNumber(instructions.fee)
        if (fee.greaterThan(api._maxFeeXRP)) {
          throw new ValidationError(`Fee of ${fee.toString(10)} XRP exceeds ` +
            `max of ${api._maxFeeXRP} XRP. To use this fee, increase ` +
            '`maxFeeXRP` in the RippleAPI constructor.')
        }
        txJSON.Fee = Utils._scaleValue(common.xrpToDrops(instructions.fee), multiplier)
        return txJSON
      }
      throw new Error('Could not prepare fee')
    }

    function prepareSequence(): TransactionJSON {
      if (instructions.sequence !== undefined) {
        if (txJSON.Sequence === undefined || instructions.sequence === txJSON.Sequence) {
          txJSON.Sequence = instructions.sequence
          return txJSON
        } else {
          // Both txJSON.Sequence and instructions.sequence are defined, and they are NOT equal
          throw new ValidationError('`Sequence` in txJSON must match `sequence` in `instructions`')
        }
      }
      if (txJSON.Sequence !== undefined) {
        return txJSON
      }

      throw new Error('Could not prepare sequence')
    }

    return this._formatPrepareResponse({
      ...prepareMaxLedgerVersion(),
      ...prepareFee(),
      ...prepareSequence()
    });
  }
}
let utils = new Utils();
let paymentFlags = txFlags.Payment;

export class XRPTxProvider {
  _isMaxAdjustment(
    source: Adjustment | MaxAdjustment): source is MaxAdjustment {
    return (source as MaxAdjustment).maxAmount !== undefined
  }

  _isMinAdjustment(
    destination: Adjustment | MinAdjustment): destination is MinAdjustment {
    return (destination as MinAdjustment).minAmount !== undefined
  }

  _isXRPToXRPPayment(payment: Payment): boolean {
    const {source, destination} = payment
    const sourceCurrency = this._isMaxAdjustment(source)
      ? source.maxAmount.currency : source.amount.currency
    const destinationCurrency = this._isMinAdjustment(destination)
      ? destination.minAmount.currency : destination.amount.currency
    return (sourceCurrency === 'XRP' || sourceCurrency === 'drops') &&
      (destinationCurrency === 'XRP' || destinationCurrency === 'drops')
  }

  _isIOUWithoutCounterparty(amount: Amount): boolean {
    return amount && amount.currency !== 'XRP' && amount.currency !== 'drops'
      && amount.counterparty === undefined
  }

  _applyAnyCounterpartyEncoding(payment: Payment): void {
    // Convert blank counterparty to sender or receiver's address
    //   (Ripple convention for 'any counterparty')
    // https://developers.ripple.com/payment.html#special-issuer-values-for-sendmax-and-amount
    _.forEach([payment.source, payment.destination], adjustment => {
      _.forEach(['amount', 'minAmount', 'maxAmount'], key => {
        if (this._isIOUWithoutCounterparty(adjustment[key])) {
          adjustment[key].counterparty = adjustment.address
        }
      })
    })
  }

  _createMaximalAmount(amount: Amount): Amount {
    const maxXRPValue = '100000000000'
    const maxIOUValue = '9999999999999999e80'
    let maxValue
    if (amount.currency === 'XRP') {
      maxValue = maxXRPValue
    } else if (amount.currency === 'drops') {
      maxValue = xrpToDrops(maxXRPValue)
    } else {
      maxValue = maxIOUValue
    }
    return _.assign({}, amount, {value: maxValue})
  }
  _createPaymentTransaction(address: string, paymentArgument: Payment) {
    const payment = _.cloneDeep(paymentArgument)
    this._applyAnyCounterpartyEncoding(payment)

    if (address !== payment.source.address) {
      throw new ValidationError('address must match payment.source.address')
    }

    if (
      (this._isMaxAdjustment(payment.source) && this._isMinAdjustment(payment.destination))
      ||
      (!this._isMaxAdjustment(payment.source) && !this._isMinAdjustment(payment.destination))
    ) {
      throw new ValidationError('payment must specify either (source.maxAmount '
        + 'and destination.amount) or (source.amount and destination.minAmount)')
    }

    const destinationAmount = this._isMinAdjustment(payment.destination)
      ? payment.destination.minAmount : payment.destination.amount
    const sourceAmount = this._isMaxAdjustment(payment.source)
      ? payment.source.maxAmount : payment.source.amount

    // when using destination.minAmount, rippled still requires that we set
    // a destination amount in addition to DeliverMin. the destination amount
    // is interpreted as the maximum amount to send. we want to be sure to
    // send the whole source amount, so we set the destination amount to the
    // maximum possible amount. otherwise it's possible that the destination
    // cap could be hit before the source cap.
    const amount =
      (this._isMinAdjustment(payment.destination) && !this._isXRPToXRPPayment(payment))
        ? this._createMaximalAmount(destinationAmount) : destinationAmount

    const txJSON: any = {
      TransactionType: 'Payment',
      Account: payment.source.address,
      Destination: payment.destination.address,
      Amount: toRippledAmount(amount),
      Flags: 0
    }

    if (payment.invoiceID !== undefined) {
      txJSON.InvoiceID = payment.invoiceID
    }
    if (payment.source.tag !== undefined) {
      txJSON.SourceTag = payment.source.tag
    }
    if (payment.destination.tag !== undefined) {
      txJSON.DestinationTag = payment.destination.tag
    }
    if (payment.memos !== undefined) {
      txJSON.Memos = _.map(payment.memos, utils._convertMemo)
    }
    if (payment.noDirectRipple === true) {
      txJSON.Flags |= paymentFlags.NoRippleDirect
    }
    if (payment.limitQuality === true) {
      txJSON.Flags |= paymentFlags.LimitQuality
    }
    if (!this._isXRPToXRPPayment(payment)) {
      // Don't set SendMax for XRP->XRP payment
      // temREDUNDANT_SEND_MAX removed in:
      // https://github.com/ripple/rippled/commit/
      //  c522ffa6db2648f1d8a987843e7feabf1a0b7de8/
      if (payment.allowPartialPayment || this._isMinAdjustment(payment.destination)) {
        txJSON.Flags |= paymentFlags.PartialPayment
      }

      txJSON.SendMax = toRippledAmount(sourceAmount)

      if (this._isMinAdjustment(payment.destination)) {
        txJSON.DeliverMin = toRippledAmount(destinationAmount)
      }

      if (payment.paths !== undefined) {
        txJSON.Paths = JSON.parse(payment.paths)
      }
    } else if (payment.allowPartialPayment === true) {
      throw new ValidationError('XRP to XRP payments cannot be partial payments')
    }

    return txJSON
  }

  _preparePayment(address: string, payment: Payment, instructions: Instructions, rippleAPI: RippleAPI) {
    if (!rippleAPI) {
      rippleAPI = new RippleAPI();
    }
    try {
      validate.preparePayment({address, payment, instructions})
      const txJSON = this._createPaymentTransaction(address, payment)
      return utils._prepareTransaction(txJSON, rippleAPI, instructions)
    } catch (e) {
      throw e;
    }
  }

  create(params: {
    recipients: Array<{ address: string; amount: string }>;
    data: string;
    tag: number;
    sourceAddress: string;
    invoiceID: string;
    fee: string;
    nonce: number;
  }) {
    const { recipients, tag, sourceAddress, invoiceID, fee, nonce } = params;
    const { address, amount } = recipients[0];
    const payment: Payment = {
      source: {
        address: sourceAddress,
        tag: tag || undefined,
        maxAmount: {
          value: amount.toString(),
          currency: 'XRP'
        }
      },
      destination: {
        address: address,
        tag: tag || undefined,
        amount: {
          value: amount.toString(),
          currency: 'XRP'
        }
      },
      invoiceID: invoiceID || undefined,
    };

    const instructions: Instructions = {
      fee: fee,
      sequence: nonce,
      maxLedgerVersion: null,
    };

    let rippleAPI = new RippleAPI();
    let txJSON = this._preparePayment(sourceAddress, payment, instructions, rippleAPI).txJSON;
    return rippleBinaryCodec.encode(txJSON);
  }

  sign(params: { tx: string; key: Key; }) {
    const { tx, key } = params;
    const txJSON = rippleBinaryCodec.decode(tx);
    let rippleAPI = new RippleAPI();
    const signedTx = rippleAPI.sign(txJSON,{
      privateKey: key.privKey,
      publicKey: key.pubKey,
    });
    return signedTx;
  }
}
