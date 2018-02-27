/**
 * This defines the message types sent over an RpcChannel.
 *
 * WARNING: Any changes to these must be backward-compatible, since Rpc may be used across
 * different versions of this library. Specifically, enums must not be renumbered, fields renamed,
 * or their types changed. Really, the only reasonable enhancement is adding a new optional field.
 */

enum MsgType {
  // Warning: Do NOT renumber enums (see warning above).
  RpcCall = 1,
  RpcRespData = 2,
  RpcRespErr = 3,
  Custom = 4,       // Used for any non-RPC messages.
}

// Message describing an RPC call.
interface MsgRpcCall {
  // Warning: Do NOT change fields (see warning above).
  mtype: MsgType.RpcCall;
  reqId?: number;       // Omitted when the method should not return a response.
  iface: string;
  meth: string;
  args: any[];
}

// Message describing an RPC successful response.
interface MsgRpcRespData {
  // Warning: Do NOT change fields (see warning above).
  mtype: MsgType.RpcRespData;
  reqId: number;
  data?: any;
}

// Message describing an RPC error response.
interface MsgRpcRespErr {
  // Warning: Do NOT change fields (see warning above).
  mtype: MsgType.RpcRespErr;
  reqId: number;
  mesg: string;
  code?: string;
}

// Message describing a non-RPC message.
interface MsgCustom {
  mtype: MsgType.Custom;
  data: any;
}

// Type of all RPC messages.
export type MsgRpc = MsgRpcCall | MsgRpcRespData | MsgRpcRespErr;

// Type for any message that may be sent over an RpcChannel.
export type Message = MsgRpc | MsgCustom;

