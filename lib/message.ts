/**
 * This defines the message types sent over an RpcChannel.
 *
 * WARNING: Any changes to these must be backward-compatible, since Rpc may be used across
 * different versions of this library. Specifically, enums must not be renumbered, fields renamed,
 * or their types changed. Really, the only reasonable enhancement is adding a new optional field.
 */

export enum MsgType {
  // Warning: Do NOT renumber enums (see warning above).
  RpcCall = 1,
  RpcRespData = 2,
  RpcRespErr = 3,
  Custom = 4,       // Used for any non-RPC messages.
}

// Message describing an RPC call.
export interface IMsgRpcCall {
  // Warning: Do NOT change fields (see warning above).
  mtype: MsgType.RpcCall;
  mpipes?: string[];
  reqId?: number;       // Omitted when the method should not return a response.
  iface: string;
  meth: string;
  args: any[];
}

// Message describing an RPC successful response.
export interface IMsgRpcRespData {
  // Warning: Do NOT change fields (see warning above).
  mtype: MsgType.RpcRespData;
  mpipes?: string[];
  reqId: number;
  data?: any;
}

// Message describing an RPC error response.
export interface IMsgRpcRespErr {
  // Warning: Do NOT change fields (see warning above).
  mtype: MsgType.RpcRespErr;
  mpipes?: string[];
  reqId: number;
  mesg: string;
  code?: string;
}

// Message describing a non-RPC message.
export interface IMsgCustom {
  mtype: MsgType.Custom;
  mpipes?: string[];
  data: any;
}

// Type of all RPC messages.
export type IMsgRpc = IMsgRpcCall | IMsgRpcRespData | IMsgRpcRespErr;

// Type for any message that may be sent over an RpcChannel.
export type IMessage = IMsgRpc | IMsgCustom;
