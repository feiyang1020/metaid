// import { UserInfo } from '@/service/btc'
import { EntitySchema } from '@/metaid-entities/entity'
import { MvcEntity } from '../entity/mvc'
import { MetaidData, UserInfo } from '@/types'
import { MetaIDWalletForMvc, Transaction } from '@/wallets/metalet/mvcWallet'
import { BtcNetwork } from '@/service/btc'
import { CreatePinResult } from './mvc'

export interface MvcConnectorStatic {
  create: ({ wallet, network }: { wallet?: MetaIDWalletForMvc; network: BtcNetwork }) => Promise<IMvcConnector>
}

export type IMvcConnector = {
  metaid: string | undefined
  address: string
  user: UserInfo
  hasUser(): boolean
  getUser({ network, currentAddress }: { network: BtcNetwork; currentAddress?: string }): Promise<UserInfo>
  createPin(
    metaidData: MetaidData,
    options: {
      signMessage?: string
      serialAction?: 'combo' | 'finish'
      transactions?: Transaction[]
      network: BtcNetwork,
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
  ): Promise<CreatePinResult>
  createPinWithAsset(
    metaidData: MetaidData,
    options: {
      assistDomian: string
      signMessage?: string
      serialAction?: 'combo' | 'finish'
      transactions?: Transaction[]
      network: BtcNetwork,
      service?: {
        address: string
        satoshis: string
      }
      outputs?: {
        address: string
        satoshis: string
      }[]
    }
  ): Promise<CreatePinResult>
  createUserInfo({
    userData,
    options,
  }: {
    userData: {
      name: string
      bio?: string
      avatar?: string
    }
    options: {
      feeRate?: number
      network?: BtcNetwork
      assistDomain?: string
    }
  }): Promise<{
    nameRes: CreatePinResult
    bioRes: CreatePinResult | undefined
    avatarRes: CreatePinResult | undefined
  }>
  updateUserInfo({
    userData,
    options,
  }: {
    userData?: {
      name?: string
      bio?: string
      avatar?: string
    }
    options: {
      feeRate?: number
      network?: BtcNetwork
    }
  }): Promise<{
    nameRes: CreatePinResult | undefined
    bioRes: CreatePinResult | undefined
    avatarRes: CreatePinResult | undefined
  }>

  hasMetaid(): boolean
  getMetaid(): string
  use(entitySymbol: string): Promise<MvcEntity>
  load(entitySchema: EntitySchema): Promise<MvcEntity>
  isConnected(): boolean
  disconnect(): void
}
