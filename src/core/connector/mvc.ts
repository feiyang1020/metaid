import { useMvc, useBtc } from '@/factories/use.js'
import { type MetaIDWalletForMvc, type Transaction } from '@/wallets/metalet/mvcWallet.js'
import { TxComposer, mvc } from 'meta-contract'
import { type User, fetchUser, fetchMetaid, fetchUtxos, notify } from '@/service/mvc.js'
import { DEFAULT_USERNAME, LEAST_AMOUNT_TO_CREATE_METAID } from '@/data/constants.js'
import { checkBalance, sleep, staticImplements } from '@/utils/index.js'
import type { EntitySchema } from '@/metaid-entities/entity.js'
import { loadBtc, loadMvc } from '@/factories/load.js'
import { errors } from '@/data/errors.js'
import type { Blockchain, MetaidData, UserInfo } from '@/types/index.js'
import { IMvcConnector, MvcConnectorStatic } from './mvcConnector'
import { BtcNetwork, getInfoByAddress } from '@/service/btc'
import { isNil, isEmpty } from 'ramda'
import { InscribeData } from '../entity/btc'
import { buildOpReturnV2 } from '@/utils/opreturn-builder'
import { sha256 } from 'bitcoinjs-lib/src/crypto'

export type CreatePinResult =
  | {
      transactions: Transaction[]
      txid?: undefined
      txids?: string[]
    }
  | {
      txid: string
      transactions?: undefined
      txids?: string[]
    }

@staticImplements<MvcConnectorStatic>()
export class MvcConnector implements IMvcConnector {
  private _isConnected: boolean
  private wallet: MetaIDWalletForMvc
  public metaid: string | undefined
  public user: UserInfo
  public host: string | undefined

  private constructor(wallet?: MetaIDWalletForMvc) {
    if (wallet) {
      this._isConnected = true
      this.wallet = wallet as MetaIDWalletForMvc
    }
  }

  get address() {
    return this.wallet?.address || ''
  }

  get xpub() {
    return this.wallet?.xpub || ''
  }

  public static async create({
    wallet,
    network,
    host,
  }: {
    wallet?: MetaIDWalletForMvc
    network: BtcNetwork
    host?: string
  }) {
    const connector = new MvcConnector(wallet)
    connector.host = host

    if (wallet) {
      connector.metaid = sha256(Buffer.from(wallet.address)).toString('hex')

      // ask api for user (to do : switch api to mvc)
      const metaidInfo = await getInfoByAddress({
        address: wallet.address,
        network: network ?? wallet.network,
        host: host,
      })
      if (!isNil(metaidInfo)) {
        connector.user = metaidInfo
      }
    }

    return connector
  }

  // metaid related
  hasUser() {
    return !!this.user
  }

  // isMetaidValid() {
  //   return this.hasUser() && !!this.user.metaid && !!this.user.protocolTxid && !!this.user.infoTxid && !!this.user.name
  // }

  async getUser({ network, currentAddress, host }: { network: BtcNetwork; currentAddress?: string; host?: string }) {
    if (!!currentAddress) {
      return await getInfoByAddress({ address: currentAddress, network, host })
    } else {
      return await getInfoByAddress({ address: this.address, network, host })
    }
  }

  async createPin(
    metaidData: Omit<MetaidData, 'revealAddr'>,
    options: {
      signMessage?: string
      serialAction?: 'combo' | 'finish'
      transactions?: Transaction[]
      network: BtcNetwork
      service?: {
        address: string
        satoshis: string
      }
      outputs?: {
        address: string
        satoshis: string
      }[]
      feeRate?: number
    }
  ): Promise<CreatePinResult> {
    if (!this.isConnected) {
      throw new Error(errors.NOT_CONNECTED)
    }
    const transactions: Transaction[] = options?.transactions ?? []

    // if (!(await checkBalance({ address: this.wallet.address, network: options?.network ?? 'testnet' }))) {
    //   throw new Error(errors.NOT_ENOUGH_BALANCE)
    // }

    const pinTxComposer = new TxComposer()

    pinTxComposer.appendP2PKHOutput({
      address: new mvc.Address(this.wallet.address, options.network),
      satoshis: 1,
    })

    const metaidOpreturn = buildOpReturnV2(metaidData, { network: options?.network ?? 'testnet' })

    pinTxComposer.appendOpReturnOutput(metaidOpreturn)

    if (options?.service && options?.service.address && options?.service.satoshis) {
      pinTxComposer.appendP2PKHOutput({
        address: new mvc.Address(options.service.address, options.network),
        satoshis: Number(options.service.satoshis),
      })
    }

    if (options?.outputs) {
      for (const output of options.outputs) {
        pinTxComposer.appendP2PKHOutput({
          address: new mvc.Address(output.address, options.network),
          satoshis: Number(output.satoshis),
        })
      }
    }

    transactions.push({
      txComposer: pinTxComposer,
      message: 'Create Pin',
    })

    if (options?.serialAction === 'combo') {
      return { transactions }
    }

    ///// apply pay
    const payRes = await this.pay({
      transactions,
      feeb: options?.feeRate,
    })

    // for (const txComposer of payRes) {
    //   await this.connector.broadcast(txComposer)
    // }
    const txIDs = await this.batchBroadcast({ txComposer: payRes, network: options.network })
    for (const [index, p] of payRes.entries()) {
      const txid = p.getTxId()

      const isValid = txIDs[index].txid === txid
      if (isValid) {
        await notify({ txHex: p.getRawHex() })
      } else {
        throw new Error('txid is not valid')
      }
    }

    return {
      txid: payRes[payRes.length - 1].getTxId(),
      txids: payRes.map((item) => item.getTxId()),
    }
  }

  async createPinWithAsset(
    metaidData: Omit<MetaidData, 'revealAddr'>,
    options: {
      assistDomian: string
      signMessage?: string
      serialAction?: 'combo' | 'finish'
      transactions?: Transaction[]
      network: BtcNetwork
      service?: {
        address: string
        satoshis: string
      }
      outputs?: {
        address: string
        satoshis: string
      }[]
      utxo?: {
        txid: string
        outIndex: number
        value: number
        address: string
      }
    }
  ): Promise<{
    txid: string
    utxo?: {
      txid: string
      outIndex: number
      value: number
      address: string
    }
  }> {
    if (!this.isConnected) {
      throw new Error(errors.NOT_CONNECTED)
    }
    const address = this.wallet.address
    let utxo = options?.utxo
    if (!utxo) {
      const utxos = await this.wallet.getUtxos()
      utxo = utxos.find((utxo) => utxo.address === address)
      if (!utxo) {
        const url = `${options.assistDomian}/v1/assist/gas/mvc/address-init`
        const preRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            gasChain: 'mvc',
            address,
          }),
        })
        const initUtxo = await preRes.json()
        if (initUtxo.error) {
          throw new Error(initUtxo.error)
        }
        if (!initUtxo.data) {
          await sleep(5000)
          const utxos = await this.wallet.getUtxos()
          utxo = utxos.find((utxo) => utxo.address === address)
          if (!utxo) {
            throw new Error('No UTXO found for address')
          }
        } else {
          utxo = {
            txid: initUtxo.data.txId,
            outIndex: initUtxo.data.index,
            value: initUtxo.data.amount,
            address: initUtxo.data.address,
          }
        }
      }
    }

    const pinTxComposer = new TxComposer()
    pinTxComposer.appendP2PKHInput({
      address: new mvc.Address(address, options.network),
      satoshis: utxo.value,
      txId: utxo.txid,
      outputIndex: utxo.outIndex,
    })

    pinTxComposer.appendP2PKHOutput({
      address: new mvc.Address(address, options.network),
      satoshis: 1,
    })
    const metaidOpreturn = buildOpReturnV2(metaidData, {
      network: options?.network ?? 'testnet',
    })
    pinTxComposer.appendOpReturnOutput(metaidOpreturn)
    const changeAddress = new mvc.Address(address, options.network)
    pinTxComposer.appendP2PKHOutput({
      address: changeAddress,
      satoshis: utxo.value,
    })
    const url = `${options.assistDomian}/v1/assist/gas/mvc/pre`
    const preRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        txHex: pinTxComposer.getRawHex(),
        address,
      }),
    })
    const preData = await preRes.json()
    if (preData.error) {
      throw new Error(preData.error)
    }
    const tx = new mvc.Transaction(preData.data.txHex)
    const txObj = tx.toObject()
    const inputs = txObj.inputs
    console.log('inputs', inputs)
    // 获取所有引用的UTXO信息

    const utxoPromises = txObj.inputs.map(async (input: any) => {
      let utxoRawUrl = `https://mvcapi${options.network === 'testnet' ? '-testnet' : ''}.cyber3.space/tx/${input.prevTxId}/raw`
      if (options.network !== 'testnet') {
        utxoRawUrl = `https://api.microvisionchain.com/open-api-mvc/tx/${input.prevTxId}/raw`
      }

      const utxoRes = await fetch(utxoRawUrl)
      return await utxoRes.json()
    })
    const _utxos = await Promise.all(utxoPromises)
    // 为每个input设置正确的output
    tx.inputs.forEach((input: any, index: number) => {
      const _tx = new mvc.Transaction(_utxos[index].hex)
      const utxo = _tx.outputs[input.outputIndex]
      tx.inputs[index].output = new mvc.Transaction.Output({
        script: utxo.script,
        satoshis: utxo.satoshis,
      })
    })
    interface UnlockP2PKHInputParams {
      transaction: {
        txComposer: string
        toSignInputs: number[]
      }[]
    }
    const txComposer = new TxComposer(tx)
    const txComposerSerialize = txComposer.serialize()
    const params: UnlockP2PKHInputParams = {
      transaction: [
        {
          txComposer: txComposerSerialize,
          toSignInputs: [0],
        },
      ],
    }

    const [_txComposerSerialize] = await this.wallet.unlockP2PKHInput(params)
    // console.log("params", params);
    const commitUrl = `${options.assistDomian}/v1/assist/gas/mvc/commit`
    const commitRes = await fetch(commitUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        txHex: TxComposer.deserialize(_txComposerSerialize).getRawHex(),
        orderId: preData.data.orderId,
      }),
    })
    const commitData = await commitRes.json()

    return {
      txid: commitData.data.txId,
      utxo: {
        txid: commitData.data.txId,
        outIndex: 2,
        value: utxo.value,
        address: address,
      },
    }
  }

  async updateUserInfo({
    userData,
    options,
  }: {
    userData?: {
      name?: string
      bio?: string
      avatar?: string
      background?: string
    }
    options: { feeRate?: number; network?: BtcNetwork }
  }): Promise<{
    nameRes: CreatePinResult | undefined
    bioRes: CreatePinResult | undefined
    avatarRes: CreatePinResult | undefined
    backgroundRes: CreatePinResult | undefined
  }> {
    const createOrModifyPin = async (
      field: string,
      value: string,
      id: string,
      encoding?: BufferEncoding,
      contentType?: string
    ) => {
      const operation = id === '' ? 'create' : 'modify'
      const path = id === '' ? `/info/${field}` : `@${id}`
      return await this.createPin(
        {
          operation,
          body: value,
          path,
          encoding,
          contentType,
          flag: 'metaid',
        },
        { network: options?.network ?? 'testnet' }
      )
    }

    const nameRes =
      userData?.name !== this.user?.name && !isNil(userData?.name) && !isEmpty(userData?.name)
        ? await createOrModifyPin('name', userData.name, this.user?.nameId ?? '')
        : undefined

    const bioRes =
      userData?.bio !== this.user?.bio && !isNil(userData?.bio) && !isEmpty(userData?.bio)
        ? await createOrModifyPin('bio', userData.bio, this.user?.bioId ?? '')
        : undefined

    const avatarRes =
      userData?.avatar !== this.user?.avatar && !isNil(userData?.avatar) && !isEmpty(userData?.avatar)
        ? await createOrModifyPin('avatar', userData.avatar, this.user?.avatarId ?? '', 'base64', 'image/jpeg;binary')
        : undefined

    const backgroundRes =
      userData?.background !== this.user?.background && !isNil(userData?.background) && !isEmpty(userData?.background)
        ? await createOrModifyPin(
            'background',
            userData.background,
            this.user?.backgroundId ?? '',
            'base64',
            'image/jpeg;binary'
          )
        : undefined

    return { nameRes, bioRes, avatarRes, backgroundRes }
  }

  async createUserInfo({
    userData,
    options,
  }: {
    userData: {
      name: string
      bio?: string
      avatar?: string
      background?: string
    }
    options: { feeRate?: number; network?: BtcNetwork; assistDomain?: string }
  }): Promise<{
    nameRes: CreatePinResult
    bioRes: CreatePinResult | undefined
    avatarRes: CreatePinResult | undefined
    backgroundRes: CreatePinResult | undefined
  }> {
    const metaDatas: MetaidData[] = []

    if (userData.name) {
      metaDatas.push({
        operation: 'create',
        body: userData.name,
        path: '/info/name',
        encoding: 'utf-8',
        contentType: 'text/plain',
        flag: 'metaid',
      })
    }
    if (userData.bio) {
      metaDatas.push({
        operation: 'create',
        body: userData.bio,
        path: '/info/bio',
        encoding: 'utf-8',
        contentType: 'text/plain',
        flag: 'metaid',
      })
    }
    if (userData.avatar) {
      metaDatas.push({
        operation: 'create',
        body: userData.avatar,
        path: '/info/avatar',
        encoding: 'base64',
        contentType: 'image/jpeg;binary',
        flag: 'metaid',
      })
    }
    if (userData.background) {
      metaDatas.push({
        operation: 'create',
        body: userData.background,
        path: '/info/background',
        encoding: 'base64',
        contentType: 'image/jpeg;binary',
        flag: 'metaid',
      })
    }
    if (metaDatas.length === 0) {
      throw new Error('No user data provided to create user info')
    }
    let _transactions: Transaction[] = []
    let _txids: string[] = []

    if (options.assistDomain) {
      let utxo: {
        txid: string
        outIndex: number
        value: number
        address: string
      } = undefined
      for (let i = 0; i < metaDatas.length; i++) {
        const metaData = metaDatas[i]
        const _options: any = {
          network: options?.network ?? 'testnet',
          signMessage: 'create User Info',
          serialAction: 'finish',
          assistDomian: options.assistDomain as string,
        }
        if (utxo) {
          _options.utxo = utxo
        }
        const { txid, utxo: _utxo } = await this.createPinWithAsset(metaData, _options)
        utxo = _utxo
        if (txid) {
          _txids.push(txid)
        }
      }
    } else {
      for (let i = 0; i < metaDatas.length; i++) {
        const metaData = metaDatas[i]
        const { transactions, txid, txids } = await this.createPin(metaData, {
          network: options?.network ?? 'testnet',
          signMessage: 'create User Info',
          serialAction: i === metaDatas.length - 1 ? 'finish' : 'combo',
          transactions: [..._transactions],
          feeRate: options?.feeRate,
        })
        _transactions = transactions
        if (txids) {
          _txids = txids
        }
      }
    }
    let ret = {
      nameRes: undefined,
      bioRes: undefined,
      avatarRes: undefined,
      backgroundRes: undefined,
    }
    let userInfos = [
      {
        key: 'name',
        resKey: 'nameRes',
      },
      {
        key: 'bio',
        resKey: 'bioRes',
      },
      {
        key: 'avatar',
        resKey: 'avatarRes',
      },
      {
        key: 'background',
        resKey: 'backgroundRes',
      },
    ]
    for (let i = 0; i < userInfos.length; i++) {
      const { key, resKey } = userInfos[i]
      if (userData[key]) {
        const txid = _txids.shift()
        ret[resKey] = {
          txid,
        }
      }
    }

    return ret
  }

  // metaid
  hasMetaid() {
    return !!this.metaid
  }

  getMetaid() {
    return this.metaid
  }

  use(entitySymbol: string) {
    return useMvc(entitySymbol, { connector: this })
  }

  load(entitySchema: EntitySchema) {
    return loadMvc(entitySchema, { connector: this })
  }

  isConnected() {
    return this._isConnected
  }

  disconnect() {
    this._isConnected = false
    this.wallet = undefined
  }

  /**
   * wallet delegation
   * signInput / send / broadcast / getPublicKey / getAddress / signMessage / pay
   */
  signInput({ txComposer, inputIndex }: { txComposer: TxComposer; inputIndex: number }) {
    return this.wallet.signInput({ txComposer, inputIndex })
  }

  pay({ transactions, feeb }: { transactions: Transaction[]; feeb?: number }) {
    return this.wallet.pay({ transactions, feeb })
  }

  send(toAddress: string, amount: number) {
    return this.wallet.send(toAddress, amount)
  }

  broadcast({ txComposer, network }: { txComposer: TxComposer; network: BtcNetwork }) {
    return this.wallet.broadcast({ txComposer, network })
  }

  batchBroadcast({ txComposer, network }: { txComposer: TxComposer[]; network: BtcNetwork }) {
    return this.wallet.batchBroadcast({ txComposer, network })
  }

  getPublicKey(path?: string) {
    return this.wallet.getPublicKey(path)
  }

  getAddress(path?: string) {
    return this.wallet.getAddress({ path })
  }

  signMessage(message: string, encoding: 'utf-8' | 'base64' | 'hex' | 'utf8' = 'hex') {
    return this.wallet.signMessage(message, encoding)
  }
}
